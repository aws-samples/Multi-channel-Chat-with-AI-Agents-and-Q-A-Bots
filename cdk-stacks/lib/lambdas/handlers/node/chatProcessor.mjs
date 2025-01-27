// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

import { randomUUID } from 'crypto';

// SPDX-License-Identifier: MIT-0
const DynamoDBService = require('./services/DynamoDBService.mjs');
const BedrockService = require('./services/BedrockService.mjs');
const PinpointService = require('./services/PinpointService.mjs');
const WhatsAppService = require('./services/WhatsAppService.mjs');
const FirehoseService = require('./services/FirehoseService.mjs');
const xss = require("xss") //https://github.com/leizongmin/js-xss

const restartKeywords = ['restart','begin','commence','initiate','launch','commence','start','demo','go','reset', 'clear']

//Helper Functions
const sendResponse = async (channel, inboundMessage, outboundMessage, knowledgeBaseId, source, kbSessionId=undefined, sessionId=undefined) => {
    
    let outboundMessageId = ''
    if (channel === 'whatsapp') {
        await WhatsAppService.markMessageAsRead(inboundMessage.inboundMessageId)
        let whatsAppResponse = await WhatsAppService.sendWhatsAppMessage(inboundMessage.originationNumber, outboundMessage, undefined,sessionId);
        outboundMessageId = whatsAppResponse?.messageId
    } else {
        let pinpointResponse = await PinpointService.sendSMS(inboundMessage.originationNumber, outboundMessage, sessionId);
        outboundMessageId = pinpointResponse?.MessageId
    }

    //Write inbound request to DynamoDB
    const inboundParams = {
        phoneNumber: inboundMessage.originationNumber,
        messageId: inboundMessage.inboundMessageId,
        channel: channel,
        timestamp: Date.now(),
        message: xss(inboundMessage.messageBody), 
        originationNumberId: inboundMessage.destinationNumber,
        direction: 'inbound',
        previousPublishedMessageId: inboundMessage.previousPublishedMessageId,
        kbSessionId: kbSessionId,
        sessionId: sessionId,
        source: source,
        knowledgeBaseId: knowledgeBaseId,
        ttl: (Date.now() / 1000) + parseInt(process.env.SESSION_SECONDS)
    }
    const putInboundResults = await DynamoDBService.put(process.env.CONTEXT_DYNAMODB_TABLE,inboundParams);
    console.debug('putInboundResults: ', putInboundResults);

    if (process.env.CONVERSATION_FIREHOSE_STREAM) {
    //Write inbound request to Firehose
    let firehoseInboundParams = {
        accountId: process.env.ACCOUNT_ID,
        organizationId: process.env.ORGANIZATION_ID,
        messageId: inboundMessage.inboundMessageId,
        sendingAddress: inboundMessage.destinationNumber,
        destinationAddress: inboundMessage.originationNumber,
        channel: channel,
        direction: 'inbound',
        knowledgeBaseId: knowledgeBaseId,
        sessionId: sessionId,
        source: source,
        timestamp: Date.now(),
        tags: {},
        message: inboundMessage.messageBody
      }
      await FirehoseService.firehoseDirectPut(process.env.CONVERSATION_FIREHOSE_STREAM, firehoseInboundParams);
    }

    //Write outbound request to DynamoDB
    const outboundParams = {
        phoneNumber: inboundMessage.originationNumber,
        messageId: outboundMessageId, 
        channel: channel,
        timestamp: Date.now(),
        message: xss(outboundMessage), //probably don't need to sanitize response from BR, but why not?
        originationNumberId: inboundMessage.destinationNumber,
        direction: 'outbound',
        previousPublishedMessageId: inboundMessage.previousPublishedMessageId,
        kbSessionId: kbSessionId,
        sessionId: sessionId,
        source: source,
        knowledgeBaseId: knowledgeBaseId,
        ttl: (Date.now() / 1000) + parseInt(process.env.SESSION_SECONDS)
    }
    const putOutboundResults = await DynamoDBService.put(process.env.CONTEXT_DYNAMODB_TABLE, outboundParams);
    console.debug('putOutboundResults: ', putOutboundResults);

    if (process.env.CONVERSATION_FIREHOSE_STREAM) {
        //Write outbound request to Firehose
        let firehoseOutboundParams = {
            accountId: process.env.ACCOUNT_ID,
            organizationId: process.env.ORGANIZATION_ID,
            messageId: outboundMessageId,
            sendingAddress: inboundMessage.destinationNumber,
            destinationAddress: inboundMessage.originationNumber,
            channel: channel,
            direction: 'outbound',
            knowledgeBaseId: knowledgeBaseId,
            sessionId: sessionId,
            source: source,
            timestamp: Date.now(),
            tags: {},
            message: xss(outboundMessage)
          }
          await FirehoseService.firehoseDirectPut(process.env.CONVERSATION_FIREHOSE_STREAM, firehoseOutboundParams);
        }

}

const getConversation = async (phoneNumber, channel) => {
    try {
        let params = {
            TableName : process.env.CONTEXT_DYNAMODB_TABLE,
            IndexName: "PhoneIndex",
            KeyConditionExpression: "phoneNumber = :phoneNumber",
            FilterExpression: "channel = :channel",
            ExpressionAttributeValues: {
                ":phoneNumber": phoneNumber,
                ":channel": channel
            }
        }
        const getConversationResults = await DynamoDBService.query(params);
        console.debug('Get Conversation Results: ', getConversationResults);
        console.debug(JSON.stringify(getConversationResults, null, 2))
        console.debug(getConversationResults.length)
        return getConversationResults
    }
    catch (error) {
        console.error(error);
        return false
    }

}

const formatConversation = (conversation) => {
    let formattedConversation = []
    for (let i = 0; i < conversation.length; i++) {
        if (conversation[i].direction === "outbound") {
            formattedConversation.push({"role": "assistant", "content": conversation[i].message});
        } else {
            formattedConversation.push({"role": "user", "content": conversation[i].message});
        }
    }
    return formattedConversation;
}

exports.handler = async (event, context, callback) => {

    try {
        console.info("App Version:", process.env.APPLICATION_VERSION)
        console.trace(`Event: `, JSON.stringify(event,null,2));

        for (const record of event.Records) {
            console.trace(`Record: `, record);
            let snsMessage = JSON.parse(record.Sns.Message)
            let message = {}
            console.trace(`Message: `, snsMessage);

            let channel = 'text'
            let sessionId = randomUUID()
            console.log(record.Sns.TopicArn)
            if (record.Sns.TopicArn === process.env.WHATSAPP_SNS_TOPIC_ARN) {
                channel = 'whatsapp'
                let whatsappMessage = JSON.parse(snsMessage.whatsAppWebhookEntry)
                try {
                    if (whatsappMessage.changes[0]?.value?.messages[0]?.text?.body) { //We have an inbound message
                        message.originationNumber = '+' + whatsappMessage.changes[0].value?.messages[0]?.from
                        message.destinationNumber = '+' + whatsappMessage.changes[0].value.metadata.display_phone_number
                        message.messageBody = whatsappMessage.changes[0].value?.messages[0]?.text?.body
                        message.inboundMessageId = whatsappMessage.changes[0].value?.messages[0]?.id
                        message.previousPublishedMessageId = whatsappMessage.changes[0]?.value?.messages[0]?.id 
                    } else {
                        //TODO: Still working to add an SNS Filter Policy to only trigger on messages from users, but the webpayload is also json encoded and SNS Filter Policies don't suport regexes or decoding a JSON payload within the message
                        console.warn('No message found.')
                        callback(null,{})
                        return
                    }
                }
                catch (error) {
                    console.error(error)
                    console.warn('No message found.')
                    callback(null,{})
                    return
                }
            } else {
                message = snsMessage
            }

            if(restartKeywords.includes(message.messageBody.toLowerCase().trim())){
                //restart conversation
                console.debug('restart conversation')
                await DynamoDBService.deleteItemsByPartitionKey(process.env.CONTEXT_DYNAMODB_TABLE, 'phoneNumber', message.originationNumber)
                await sendResponse(channel, message,'Please ask a question.',process.env.KNOWLEDGE_BASE_ID, undefined, undefined, sessionId);

            } else {
                //Get Conversation
                let conversation = await getConversation(message.originationNumber, channel)

                //Set Session Ids if we have them.
                let kbSessionId = false
                if (conversation[conversation.length - 1]?.kbSessionId) kbSessionId = conversation[conversation.length - 1].kbSessionId
                if (conversation[conversation.length - 1]?.sessionId) sessionId = conversation[conversation.length - 1].sessionId

                console.log('sessionId: ', sessionId);
                
                if (process.env.USE_BEDROCK_AGENT === 'false') {
                    //Call to KB
                    let retrieveResponse = await BedrockService.retrieveAndGenerate(message.messageBody, process.env.KNOWLEDGE_BASE_ID, kbSessionId)

                    let response = `I'm sorry, I couldn't find an answer based on the information available to me.`
                    let source = 'Bedrock Knowledge Base'
                    if(retrieveResponse.citations[0]?.retrievedReferences.length){ //We have at least one citation
                        response = retrieveResponse.output.text
                    } else { //Couldn't find and answer in KB, so send conversation to general LLM. Comment out this bit to use only KB responses.
                        let formattedConversation = formatConversation(conversation)

                        //Add most recent question to conversation:
                        formattedConversation.push({"role": "user", "content": message.messageBody})

                        //Call to general model
                        const promptEnvelope = {
                            "messages":formattedConversation,
                            "anthropic_version":"bedrock-2023-05-31",
                            "max_tokens": parseInt(process.env.LLM_MAX_TOKENS), 
                            "temperature": parseFloat(process.env.LLM_TEMPERATURE)
                        }

                        source = "General LLM"
                        let parsedResponse = await BedrockService.invokeModel(promptEnvelope);
                        response = parsedResponse.content[0].text
                    } 

                    if (!kbSessionId) kbSessionId = retrieveResponse.kbSessionId //making sure we carry over kbSessionId across different LLMs

                    await sendResponse(channel, message, response, process.env.KNOWLEDGE_BASE_ID, source, kbSessionId, sessionId)

                } else {
                    // call an amazon bedrock agent
                    let agentResponse = await BedrockService.invokeAgent(message.messageBody,sessionId)
                    console.log('agentResponse: ', agentResponse)

                    let response = agentResponse.completion
                    let source = 'Bedrock Agent'
                    await sendResponse(channel, message, response, process.env.BEDROCK_AGENT_ID, source, kbSessionId, sessionId)
                }
                
                callback(null,{})
            }
        }
    }
    catch (error) {
        console.error(error);
        callback(error)
    }
}
