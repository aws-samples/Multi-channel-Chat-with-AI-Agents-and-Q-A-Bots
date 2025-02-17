// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {CfnOutput, Stack, StackProps, Duration, CustomResource, RemovalPolicy} from "aws-cdk-lib";
import {Construct} from "constructs";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import {Runtime} from "aws-cdk-lib/aws-lambda";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from "aws-cdk-lib/aws-kms"
import { bedrock } from "@cdklabs/generative-ai-cdk-constructs";
import * as opensearchserverless from '@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/opensearchserverless';
import * as logs from "aws-cdk-lib/aws-logs"
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';
import { NagSuppressions } from 'cdk-nag'
import path = require('path');

const configParams = require('../config.params.json');

export class CdkBackendStack extends Stack {

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ssmParams = loadSSMParams(this);

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'This is the default Lambda Execution Policy which just grants writes to CloudWatch.'
      },{
        id: 'AwsSolutions-IAM5',
        reason: 'This is the Log Retention Policies created by the Bedrock CDK Construct for the Open Search Logs. We dont have control over this policy, but it would need to create delete policies at the account level, so not sure how it would scope this down any further.'
      },
    ])

    //log bucket
    const accessLogsBucket = new s3.Bucket(this, "accessLogsBucket", {
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: RemovalPolicy.RETAIN, 
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
    });

    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
        {
          id: 'AwsSolutions-S1',
          reason: 'This is the Log Bucket.'
        },
    ])

    let knowledgeBase: bedrock.IKnowledgeBase | undefined;
    let docsBucket: s3.Bucket | undefined;
    let dataSource: bedrock.S3DataSource | undefined;
    
    if (!ssmParams.useBedrockAgent) {

      // Bedrock Knowledge Base
      docsBucket = new s3.Bucket(this, "docsBucket", {
        lifecycleRules: [{
          expiration: Duration.days(10),
        }],
        blockPublicAccess: {
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        },
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.RETAIN, 
        serverAccessLogsBucket: accessLogsBucket,
        serverAccessLogsPrefix: 'kbdocs',
      });

      knowledgeBase = new bedrock.VectorKnowledgeBase(
        this,
        "docsKnowledgeBase",
        {
          embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
          vectorStore: new opensearchserverless.VectorCollection(this, 'VectorCollection', {
            collectionName: `${configParams.CdkAppName.toLowerCase()}collection`,
            standbyReplicas: ssmParams.cloudsearchReplicasEnabled ? opensearchserverless.VectorCollectionStandbyReplicas.ENABLED : opensearchserverless.VectorCollectionStandbyReplicas.DISABLED,
          }), 
        }
      );

      dataSource = new bedrock.S3DataSource(
        this,
        "docsDataSource",
        {
          bucket: docsBucket,
          knowledgeBase: knowledgeBase,
          dataSourceName: "docs",
          chunkingStrategy: bedrock.ChunkingStrategy.FIXED_SIZE
        }
      );
    };

    //// Uncomment the following to use a web scraper data source
    // const knowledgeBase = new bedrock.KnowledgeBase(
    //   this,
    //   "webKnowledgeBase",
    //   {
    //     embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
    //   }
    // );

    // //Web Data Sources aren't currently supported in CloudFormation, so using API and Custom Resource to deploy
    // const eumCreateWebDataSource = new CustomResource(this, `${configParams.CdkAppName}-EUMCreateWebDataSource`, {
    //   resourceType: 'Custom::CreateWebDatasource',
    //   serviceToken: cLambda.functionArn,
    //   properties: {
    //       KnowledgeBaseId: knowledgeBase.knowledgeBaseId,
    //       CrawlURL: 'https://www.aboutamazon.com/about-us', //Change this to the URL you want to crawl, It is not recommended to use the root URL.
    //   }
    // });

    //SNS Topic for 2-way SMS
    const aws_sns_kms = kms.Alias.fromAliasName(
      this,
      "aws-managed-sns-kms-key",
      "alias/aws/sns",
    )
    const chatTopic = new sns.Topic(this,'notification', {
      displayName: `${configParams.CdkAppName}-NotificationTopic`,
      masterKey: aws_sns_kms
    })

    const snsRole = new iam.Role(this, 'snsRole', {
      assumedBy: new iam.ServicePrincipal('sms-voice.amazonaws.com')
    });

    snsRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sns:Publish",
        ],
        resources: [
          chatTopic.topicArn
        ]
      })
    )

    //Custom Resource Lambda
    const configLambda = new nodeLambda.NodejsFunction(this, 'ConfigLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'lambdas/handlers/node/customResource.mjs'),
      timeout: Duration.seconds(30),
      memorySize: 512,
      initialPolicy: 
      [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sms-voice:UpdatePhoneNumber",
          ],
          resources: [
              `arn:aws:sms-voice:${this.region}:${this.account}:phone-number/${ssmParams.originationNumberId}`
          ]
        }),new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "iam:PassRole"
          ],
          resources: [
              `${snsRole.roleArn}`
          ]
        })
      ]
    });

    if (knowledgeBase) {
      configLambda.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:StartIngestionJob",
          "bedrock:CreateDataSource",
          "bedrock:DeleteDataSource"
        ],
          resources: knowledgeBase ? [`${knowledgeBase.knowledgeBaseArn}/*`] : []
        }),
      );
    }

    NagSuppressions.addResourceSuppressionsByPath(this, '/MultiChannelGenAIDemo/ConfigLambda/ServiceRole/DefaultPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'This is a Custom Resource Lambda that is only used during stack deployment to configure the Bedrock Knowledge Base. The methods have been scoped down according to: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html#amazonbedrock-CreateDataSource and https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonpinpointsmsvoicev2.html#amazonpinpointsmsvoicev2-UpdatePhoneNumber'
      },
    ])

    //Chat Context Table
    const contextTable = new dynamodb.Table(this, 'ChatContext', { 
      partitionKey: { name: 'phoneNumber', type: dynamodb.AttributeType.STRING }, 
      sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN 
    });

    contextTable.addGlobalSecondaryIndex({
      indexName: 'PhoneIndex',
      partitionKey: {
        name: 'phoneNumber',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    //Custom Log Group so we can add Metric Filters
    const logGroup = new logs.LogGroup(this, 'EUMChatProcessorLambdaLogGroup',{
      retention: logs.RetentionDays.THREE_MONTHS
    });

    const chatProcessorLambda = new nodeLambda.NodejsFunction(this, 'chatProcessorLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'lambdas/handlers/node/chatProcessor.mjs'),
      timeout: Duration.seconds(30),
      memorySize: 512,
      logFormat: 'JSON',
      applicationLogLevel: 'INFO',
      logGroup: logGroup,
      bundling: {
        externalModules: [], //forces use local aws-sdk...remove when social-messaging is available in lambda runtime
      },
      environment: { 
          "APPLICATION_VERSION": `v${this.node.tryGetContext('application_version')} (${new Date().toISOString()})`,
          "CONTEXT_DYNAMODB_TABLE": contextTable.tableName,
          "PHONE_NUMBER_ID": ssmParams.originationNumberId,
          "SMS_SNS_TOPIC_ARN": chatTopic.topicArn,
          "WHATSAPP_PHONE_NUMBER_ID": ssmParams.eumWhatsappOriginationNumberId,
          "WHATSAPP_SNS_TOPIC_ARN": ssmParams.eumWhatsappSNSTopicArn,
          "BEDROCK_MODEL_ID": "anthropic.claude-3-haiku-20240307-v1:0", // aws bedrock list-foundation-models --by-provider Anthropic
          "USE_BEDROCK_AGENT": `${ssmParams.useBedrockAgent.toString()}`,
          "BEDROCK_AGENT_ID": ssmParams.bedrockAgentId,
          "BEDROCK_AGENT_ALIAS_ID": ssmParams.bedrockAgentAliasId,
          "SESSION_SECONDS": "600",
          "KNOWLEDGE_BASE_ID": knowledgeBase?.knowledgeBaseId ?? '', 
          "LLM_MAX_TOKENS": "300",
          "LLM_TEMPERATURE": "0.3",
          "CONFIGURATION_SET": ssmParams.configurationSet == 'not-defined' ? undefined : ssmParams.configurationSet,
          "ACCOUNT_ID": `${this.account}`,
          "ORGANIZATION_ID": '', //Update this if you need more granularity in your Firehose Stream for things like brands or other organizational units
          "CONVERSATION_FIREHOSE_STREAM": ssmParams.conversationFirehoseStream == 'not-defined' ? undefined : ssmParams.conversationFirehoseStream,
        }
    });
    //Policy for Lambda
    chatProcessorLambda.role?.attachInlinePolicy(new iam.Policy(this, 'chatProcessorPolicy', {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [                
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:Scan",
                "dynamodb:PutItem",
                "dynamodb:BatchWriteItem",
                "dynamodb:DeleteItem"
            ],
            resources: [
              contextTable.tableArn, 
              `${contextTable.tableArn}/*`
            ]
        }),        
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [                
            "social-messaging:DeleteWhatsAppMessageMedia",
            "social-messaging:SendWhatsAppMessage",
            "social-messaging:PostWhatsAppMessageMedia",
            "social-messaging:GetWhatsAppMessageMedia"
          ],
          resources: [`arn:aws:social-messaging:${this.region}:${this.account}:phone-number-id/*`]
        }),
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [                
              "sms-voice:SendTextMessage",
              "sms-voice:SendMediaMessage"
            ],
            resources: [
              `arn:aws:sms-voice:${this.region}:${this.account}:phone-number/${ssmParams.originationNumberId}`
            ]
        }),
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [                
              "bedrock:InvokeModel",
              "bedrock:Retrieve"
            ],
            resources: [  
              `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
              `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
            ] 
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [                
            "bedrock:InvokeAgent"
          ],
          resources: [`arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${ssmParams.bedrockAgentId}/${ssmParams.bedrockAgentAliasId}`] 
        }),
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [                
              "firehose:PutRecord",
              "firehose:PutRecordBatch"
            ],
            resources: [`arn:aws:firehose:${this.region}:${this.account}:deliverystream/${ssmParams.conversationFirehoseStream}`] 
        }),
      ]
    }));

    if (knowledgeBase) {
      chatProcessorLambda.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [                
            "bedrock:RetrieveAndGenerate",
            "bedrock:Retrieve"
          ],
          resources: [knowledgeBase?.knowledgeBaseArn ?? ''] 
        }),
      );  
    }

    NagSuppressions.addResourceSuppressionsByPath(this, '/MultiChannelGenAIDemo/chatProcessorPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The function needs to call the RetrieveAndGenerate API, which has a wildcard resource. There is no way to scope this down based on: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html#amazonbedrock-RetrieveAndGenerate'
      },
    ])
    
    if (ssmParams.smsEnabled) {
      // subscribe an Lambda to SMS SNS topic
      chatTopic.addSubscription(new subscriptions.LambdaSubscription(chatProcessorLambda));

      snsRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sns:Publish",
            "sns:Subscribe",
          ],
          resources: [
            chatTopic.topicArn
          ]
        })
      )
    } 
    if (ssmParams.whatsappEnabled) {
      const whatsappTopic = sns.Topic.fromTopicArn(this, 'whatsappTopic', ssmParams.eumWhatsappSNSTopicArn)
      whatsappTopic.addSubscription(new subscriptions.LambdaSubscription(chatProcessorLambda))
      //TODO: We could use an SNS Filter Policy to only trigger on messages from users, but the webpayload is also json encoded and SNS Filter Policies don't suport regexes or decoding a JSON payload within the message
      snsRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sts:AssumeRole",
          ],
          resources: [
            ssmParams.eumWhatsappSNSTopicArn
          ]
        })
      )
    }


    const configCustomResource = new CustomResource(this, `${configParams.CdkAppName}-ConfigCustomResource`, {
        resourceType: 'Custom::EUMConfig',
        serviceToken: configLambda.functionArn,
        properties: {
            OriginationNumberId: ssmParams.originationNumberId,
            ChatSNSTopicARN: chatTopic.topicArn,
            SNSRoleARN: snsRole.roleArn,
        }
    });
  
    /**************************************************************************************************************
      * CDK Outputs *
    **************************************************************************************************************/

    new CfnOutput(this, "chatProcessorLambdaName", {
      value: chatProcessorLambda.functionName
    });

    new CfnOutput(this, "chatProcessorLambdaARN", {
      value: chatProcessorLambda.functionArn
    });

    new CfnOutput(this, "DocsBucketName", {
      value: docsBucket?.bucketName ?? 'Not Created',
    });

    new CfnOutput(this, "KnowledgeBaseId", {
      value: knowledgeBase?.knowledgeBaseId ?? 'Not Created',
    });
  }
}
