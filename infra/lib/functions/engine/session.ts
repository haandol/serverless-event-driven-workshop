import * as AWS from 'aws-sdk';
import * as awsLambda from 'aws-lambda';

const TableName: string = process.env['TABLE_NAME']!;

let dynamodb: AWS.DynamoDB.DocumentClient | undefined = undefined;

interface IBody {
  accountId: string;
  sessionId: string;
}

export const handler = async (event: awsLambda.APIGatewayProxyEventV2, context: any): Promise<awsLambda.APIGatewayProxyResultV2>  => {
  console.log(event);

  if (!dynamodb) dynamodb = new AWS.DynamoDB.DocumentClient();

  const body: IBody = JSON.parse(event.body!);
  const { accountId, sessionId } = body;

  await dynamodb.put({
    TableName,
    Item: {
      accountId,
      sessionId,
      createdAt: +new Date(),
    },
    ConditionExpression: 'attribute_not_exists(sessionId)',
  }).promise();

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*'
    },
    body: `Session created: ${sessionId}`,
  };
}