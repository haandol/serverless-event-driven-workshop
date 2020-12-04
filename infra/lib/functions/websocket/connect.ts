import * as awsLambda from 'aws-lambda';

export const handler = async (event: awsLambda.APIGatewayProxyEvent, context: any): Promise<awsLambda.APIGatewayProxyResult>  => {
  console.log(event);

  return {
    statusCode: 200,
    body: event.requestContext.connectionId!,
  };
}