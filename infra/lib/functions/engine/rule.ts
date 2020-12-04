import * as AWS from 'aws-sdk';
import * as awsLambda from 'aws-lambda';

const TableName: string = process.env['TABLE_NAME']!;
const QueueUrl: string = process.env['QUEUE_URL']!;

let dynamodb: AWS.DynamoDB.DocumentClient | undefined = undefined;
let sqs: AWS.SQS | undefined = undefined;

interface IBody {
  accountId: string;
  sessionId: string;
  userMove: string;
}

export const handler = async (event: awsLambda.APIGatewayProxyEventV2, context: any): Promise<awsLambda.APIGatewayProxyResultV2>  => {
  console.log(event);

  if (!dynamodb) dynamodb = new AWS.DynamoDB.DocumentClient();
  if (!sqs) sqs = new AWS.SQS();

  const body: IBody = JSON.parse(event.body!.toString());
  const { accountId, sessionId, userMove } = body;

  if (!validateUserMove(userMove)) {
    return {
      statusCode: 400,
      body: `[${userMove}] is invalid input`,
    }
  }

  const lastMove = getLastMove(userMove);
  try {
    await dynamodb.put({
      TableName,
      Item: {
        accountId,
        sessionId,
        lastMove,
      },
      ConditionExpression: 'attribute_exists(sessionId)',
    }).promise();
  } catch (e) {
    return {
      statusCode: 500,
      body: `make sure you have started a game before make your move`,
    }
  }

  const messageBody = JSON.stringify({
    sessionId,
    lastMove,
  });
  await sqs.sendMessage({
    QueueUrl,
    MessageBody: messageBody,
    MessageGroupId: `${accountId}-${sessionId}`,
    MessageDeduplicationId: `${accountId}-${sessionId}-${userMove}`,
  }).promise();
  return {
    statusCode: 200,
    body: messageBody,
  }
}

function validateUserMove(userMove: string): boolean {
  const moves = userMove.replace(/\s/g, '').split(',');
  if (moves.length === 0) return false;
  if (moves.length > 3) return false;
  for (const move of moves) {
    if (isNaN(<any>move)) return false;
  }
  return true;
}

function getLastMove(userMove: string): number {
  const moves = userMove.replace(/\s/g, '').split(',');
  return parseInt(moves[moves.length - 1]);
}