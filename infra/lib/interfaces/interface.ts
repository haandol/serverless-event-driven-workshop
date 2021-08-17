import * as apigwv2 from '@aws-cdk/aws-apigatewayv2';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as sqs from '@aws-cdk/aws-sqs';

export interface SessionProps {
  httpApi: apigwv2.HttpApi;
}

export interface RuleProps {
  httpApi: apigwv2.HttpApi;
  sessionTable: dynamodb.ITable;
  messageQueue: sqs.IQueue;
}

export interface GameProps {
  wsApi: apigwv2.IWebSocketApi;
  wsApiStage: apigwv2.IWebSocketStage;
  messageQueue: sqs.IQueue;
}

