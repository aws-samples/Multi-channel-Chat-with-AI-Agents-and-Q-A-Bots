// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SocialMessagingClient, SendWhatsAppMessageCommand } from "@aws-sdk/client-socialmessaging";
const client = new SocialMessagingClient({region: process.env.AWS_REGION});

export async function markMessageAsRead (messageId) {
  let message = {
    "messaging_product": "whatsapp",
    "message_id": messageId,
    "status": "read"
  }

  let params = {
    originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, 
    message: new TextEncoder().encode(JSON.stringify(message)), 
    metaApiVersion: "v19.0", 
  }

  try {
    const command = new SendWhatsAppMessageCommand(params);
    const response = await client.send(command);
    return response
  } catch (error) {
      console.error('WhatsAppService.markMessageAsRead: ', error);
      throw new Error(error.message);
  }
} 


export async function sendWhatsAppMessage (destinationNumber, outboundMessage, previewUrl = false, sessionId=undefined) {
  let message = {
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": destinationNumber,
    "type": "text",
    "text": {
      "preview_url": previewUrl,
      "body": outboundMessage
    }
  }
  if(sessionId) {
    message.biz_opaque_callback_data = sessionId
  }

  let params = {
    originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, 
    message: new TextEncoder().encode(JSON.stringify(message)), 
    metaApiVersion: "v19.0", 
  }

  try {
    const command = new SendWhatsAppMessageCommand(params);
    const response = await client.send(command);
    return response
  } catch (error) {
      console.error('WhatsAppService.sendWhatsAppMessage: ', error);
      throw new Error(error.message);
  }
}

export async function sendWhatsAppImage (destinationNumber, mediaId, outboundMessage) {
  let message = {
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": destinationNumber,
    "type": "image",
    "image": {
      "id" : mediaId,
      "caption": outboundMessage
    }
  }

  let params = {
    originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, 
    message: new TextEncoder().encode(JSON.stringify(message)), 
    metaApiVersion: "v19.0", 
  }

  try {
    const command = new SendWhatsAppMessageCommand(params);
    const response = await client.send(command);
    return response
  } catch (error) {
      console.error('WhatsAppService.sendWhatsAppImage: ', error);
      throw new Error(error.message);
  }
}

export async function sendWhatsAppTemplateMessage (destinationNumber, templateName, parameters) {
  let message = {
    "messaging_product": "whatsapp",
    "to": destinationNumber,
    "type": "template",
    "template": 
    {
      "name": templateName,
      "language": 
      {
        "code": "en"
      },
      "components": [
        {
          "type": "body",
          "parameters": parameters
        }
      ]
    }
  }

  let params = {
    originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, 
    message: new TextEncoder().encode(JSON.stringify(message)), 
    metaApiVersion: "v19.0", 
  }

  try {
    const command = new SendWhatsAppMessageCommand(templateMessage);
    const response = await client.send(command);
    return response
  } catch (error) {
      console.error('WhatsAppService.sendWhatsAppTemplateMessage: ', error);
      throw new Error(error.message);
  }
}

