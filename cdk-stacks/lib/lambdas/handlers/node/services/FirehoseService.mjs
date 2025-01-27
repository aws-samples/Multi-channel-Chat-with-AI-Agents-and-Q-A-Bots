const { FirehoseClient, PutRecordCommand } = require("@aws-sdk/client-firehose");
const firehoseClient = new FirehoseClient({}); 

export async function firehoseDirectPut(streamName, data) {
  const record = {
    DeliveryStreamName: streamName,
    Record: { Data: Buffer.from(JSON.stringify(data)) }
  };

  try {
    // Create the command
    const command = new PutRecordCommand(record);

    // Send the command
    const response = await firehoseClient.send(command);
    return response;
  } catch (error) {
    console.error("Firehose.firehoseDirectPut:", error);
    throw error;
  }
}