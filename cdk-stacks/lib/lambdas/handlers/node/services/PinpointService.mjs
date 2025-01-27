// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PinpointSMSVoiceV2Client, SendTextMessageCommand, SendMediaMessageCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2"; 
const pinpoint = new PinpointSMSVoiceV2Client({ region: process.env.AWS_REGION });

export async function sendSMS (destinationNumber, message, sessionId=undefined) {
  let configurationSet = process.env.CONFIGURATION_SET
  const pinpointInput = { 
    DestinationPhoneNumber: destinationNumber, 
    OriginationIdentity: process.env.PHONE_NUMBER_ID,
    MessageBody: message, 
    DryRun: false,
  };
  if(process.env.CONFIGURATION_SET) pinpointInput.ConfigurationSetName = process.env.CONFIGURATION_SET
  if(sessionId) {
    pinpointInput.Context = {
      sessionId: sessionId
    }
  }
  console.trace(pinpointInput)

  try {
    const pinpointCommand = new SendTextMessageCommand(pinpointInput);
    const pinpointResponse = await pinpoint.send(pinpointCommand);
    return pinpointResponse
  } catch (error) {
      console.error('Pinpoint.SendTextMessageCommand: ', error);
      throw new Error(error.message);
  }
}

export async function sendMMS (destinationNumber, message, s3URI) {
  const pinpointInput = { 
    DestinationPhoneNumber: destinationNumber, 
    OriginationIdentity: process.env.PHONE_NUMBER_ID,
    MessageBody: message, 
    DryRun: false,
  };
  if(process.env.CONFIGURATION_SET) pinpointInput.ConfigurationSetName = process.env.CONFIGURATION_SET
  //Add Optional Items
  if(s3URI) pinpointInput.MediaUrls = [s3URI]

  console.trace(pinpointInput)

  try {
    const pinpointCommand = new SendMediaMessageCommand(pinpointInput);
    const pinpointResponse = await pinpoint.send(pinpointCommand);
    return pinpointResponse
  } catch (error) {
      console.error('Pinpoint.SendMediaMessageCommand: ', error);
      throw new Error(error.message);
  }
}

