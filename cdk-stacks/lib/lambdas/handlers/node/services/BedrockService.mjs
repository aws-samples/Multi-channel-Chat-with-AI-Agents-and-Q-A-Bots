// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

import { BedrockAgentRuntimeClient, InvokeAgentCommand, RetrieveAndGenerateCommand } from "@aws-sdk/client-bedrock-agent-runtime";
const agentRuntime = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION });

const { BedrockAgentClient, StartIngestionJobCommand } = require("@aws-sdk/client-bedrock-agent"); 
const agent = new BedrockAgentClient({ region: process.env.AWS_REGION });

export async function invokeModel (promptEnvelope) {

  const input = { // InvokeModelRequest
      body: JSON.stringify(promptEnvelope),
      contentType: "application/json",
      accept: "application/json",
      modelId: process.env.BEDROCK_MODEL_ID, 
  };
  console.trace(input)

  try {
    const bedrockCommand = new InvokeModelCommand(input);
    const bedrockResponse = await bedrock.send(bedrockCommand);
    console.trace(bedrockResponse)
    const response = new TextDecoder().decode(bedrockResponse.body)
    return JSON.parse(response)
  } catch (error) {
      console.error('Bedrock.invokeModel: ', error);
      throw new Error(error.message);
  }
}

export async function invokeAgent (prompt, sessionId) {

  const agentId = process.env.BEDROCK_AGENT_ID;
  const agentAliasId = process.env.BEDROCK_AGENT_ALIAS_ID;

  const command = new InvokeAgentCommand({
    agentId,
    agentAliasId,
    sessionId,
    inputText: prompt,
  });

  try {

    let completion = "";
    const response = await agentRuntime.send(command);

    if (response.completion === undefined) {
      throw new Error("Completion is undefined");
    }

    for await (const chunkEvent of response.completion) {
      const chunk = chunkEvent.chunk;
      console.log('chunk: ',chunk);
      const decodedResponse = new TextDecoder("utf-8").decode(chunk.bytes);
      completion += decodedResponse;
    }

    return { completion };

  } catch (error) {
    console.error('InvokeAgent error: ', error);
    if (error.name == "ThrottlingException"){
      return {output:{text:'Request Rate exceeded, please wait a minute and try again'}}
    } else {
      throw new Error(error.message);
    }
  }
}

export async function retrieveAndGenerate (prompt, knowledgeBaseId, sessionId=undefined, promptTemplate=undefined) {

  const input = {
    input: {
      text: prompt, 
    },
    retrieveAndGenerateConfiguration: {
      type: "KNOWLEDGE_BASE", 
      knowledgeBaseConfiguration: {
        knowledgeBaseId: knowledgeBaseId, 
        modelArn: `arn:aws:bedrock:${process.env.AWS_REGION}::foundation-model/${process.env.BEDROCK_MODEL_ID}`,
        generationConfiguration: {
          inferenceConfig: {
            textInferenceConfig: {
              maxTokens: parseInt(process.env.LLM_MAX_TOKENS), 
              temperature: parseFloat(process.env.LLM_TEMPERATURE)
            }
          },
        },
      },
    },
  };

  //Override defaults
  if (sessionId) input.sessionId = sessionId

  if (promptTemplate){
    input.retrieveAndGenerateConfiguration.knowledgeBaseConfiguration.generationConfiguration.promptTemplate = {
        textPromptTemplate: promptTemplate
    }
  }

  console.trace(input)

  try {
    const command = new RetrieveAndGenerateCommand(input);
    const response = await agentRuntime.send(command);
    console.trace(response)
    return response
  } catch (error) {
      console.error('Bedrock.retrieveAndGenerate: ', error);
      if (error.name == "ThrottlingException"){
        return {output:{text:'Request Rate exceeded, please wait a minute and try again'}}
      } else {
        throw new Error(error.message);
      }
  }
}

export async function startIngestionJob (context) {

  const input = {
    knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID, 
    dataSourceId: process.env.DATA_SOURCE_ID, 
    clientToken: context.awsRequestId, 
  };
  console.trace(input)
  
  try {
    const command = new StartIngestionJobCommand(input);
    const response = await agent.send(command);
    console.trace(response)
    return response
  } catch (error) {
      console.error('Bedrock.startIngestionJob: ', error);
      throw new Error(error.message);
  }
}