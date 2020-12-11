import * as _ from 'lodash';
import * as AWS from 'aws-sdk';
import * as awsLambda from 'aws-lambda';

const WsEndpoint = process.env['WS_ENDPOINT']!;
const QueueUrl: string = process.env['QUEUE_URL']!;

let client: AWS.ApiGatewayManagementApi | undefined = undefined;
let sqs: AWS.SQS | undefined = undefined;

interface IBody {
  sessionId: string;
  lastMove: number;
}

const END = 13;
const CHEAT_SHEET = _.reverse(generateCheatSheet(END));

function generateCheatSheet(num: number): number[] {
  const sheet = new Array();
  let i = num;
  while (i > 4) {
    sheet.push(i);
    i -= 4;
  }
  return sheet;
}

export const handler = async (event: awsLambda.SQSEvent, context: any): Promise<awsLambda.APIGatewayProxyResultV2> => {
  console.log(event);

  if (!client) {
    const endpoint = WsEndpoint.replace('wss://', 'https://');
    client = new AWS.ApiGatewayManagementApi({ endpoint: `${endpoint}` });
  }
  if (!sqs) sqs = new AWS.SQS();

  for (const record of event.Records) {
    const receiptHandle = record.receiptHandle;
    const body: IBody = JSON.parse(record.body);
    const { sessionId, lastMove } = body;

    const nextMove = getNextMove(lastMove);
    try {
      await client.postToConnection({
        Data: Buffer.from(JSON.stringify({ data: nextMove }), 'utf8'),
        ConnectionId: sessionId,
      }).promise();
      console.log('sent to socket');
    } finally {
      await sqs.deleteMessage({
        QueueUrl,
        ReceiptHandle: receiptHandle,
      }).promise();
      console.log('delete message');
    }
  }

  return {
    statusCode: 200,
    body: 'ok',
  };
}

function getNextMove(lastMove: number): string {
  if (lastMove === END) return 'You lose..';

  const currentMove = lastMove + 1;
  if (currentMove === END) return 'You win!!';

  for (const losingNumber of CHEAT_SHEET) {
    if (currentMove > losingNumber) continue;

    if (currentMove === losingNumber) {
      return convertToString([currentMove]);
    }

    return convertToString(_.slice(_.range(currentMove, losingNumber), 0, 3));
  }

  // error state
  console.error(`Could not calculate for userMove: ${lastMove}`);
  return 'You win!!';
}

function convertToString(moves: number[]): string {
  return _.forEach(moves, (move) => `${move}`).join(',')
}