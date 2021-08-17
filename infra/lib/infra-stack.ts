import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as apigwv2 from '@aws-cdk/aws-apigatewayv2';
import * as integrations from '@aws-cdk/aws-apigatewayv2-integrations';
import * as lambda from '@aws-cdk/aws-lambda';
import * as nodeLambda from '@aws-cdk/aws-lambda-nodejs';
import * as sqs from '@aws-cdk/aws-sqs';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import { SessionProps, RuleProps, GameProps } from './interfaces/interface';
import { ns } from './interfaces/config';

class WebsocketApi extends cdk.Construct {
  public readonly api: apigwv2.IWebSocketApi;
  public readonly stage: apigwv2.IWebSocketStage;

  constructor(scope: cdk.Construct, id: string) {
    super(scope, id);
    
    this.api = new apigwv2.WebSocketApi(this, id, {
      apiName: `${ns}WsApi`,
      routeSelectionExpression: '$request.body.action',
    });
    this.stage = new apigwv2.WebSocketStage(this, `${id}Stage`, {
      webSocketApi: this.api,
      stageName: 'dev',
      autoDeploy: true,
    });
    new cdk.CfnOutput(this, `${id}Url`, {
      exportName: 'WsApiUrl',
      value: `${this.api.apiEndpoint}/${this.stage.stageName}`,
    });

    const connectFunction = new nodeLambda.NodejsFunction(this, `ConnectFunction`, {
      entry: path.resolve(__dirname, 'functions', 'websocket', 'connect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      timeout: cdk.Duration.seconds(5),
      functionName: `${ns}Connect`,
    });
    const connectInteg = new integrations.LambdaWebSocketIntegration({
      handler: connectFunction,
    })
    new apigwv2.WebSocketRoute(this, `ConnectRoute`, {
      webSocketApi: this.api,
      routeKey: '$connect',
      integration: connectInteg,
    });

    const disconnectFunction = new nodeLambda.NodejsFunction(this, `DisconnectFunction`, {
      entry: path.resolve(__dirname, 'functions', 'websocket', 'disconnect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      timeout: cdk.Duration.seconds(5),
      functionName: `${ns}Disconnect`,
    });
    const disconnectInteg = new integrations.LambdaWebSocketIntegration({
      handler: disconnectFunction,
    });
    new apigwv2.WebSocketRoute(this, `DisconnectRoute`, {
      webSocketApi: this.api,
      routeKey: '$disconnect',
      integration: disconnectInteg,
    });
  }
}

class HttpApi extends cdk.Construct {
  public readonly api: apigwv2.HttpApi;

  constructor(scope: cdk.Construct, id: string) {
    super(scope, id);

    this.api = new apigwv2.HttpApi(this, id, {
      apiName: `${ns}GameApi`,
      corsPreflight: {
        allowHeaders: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(10),
      },
    });

    new cdk.CfnOutput(this, `${id}Url`, {
      exportName: 'HttpApiUrl',
      value: `${this.api.url}` || 'undefined',
    });
  }
}

class SessionEngine extends cdk.Construct {
  public readonly sessionTable: dynamodb.Table;

  constructor(scope: cdk.Construct, id: string, props: SessionProps) {
    super(scope, id);

    this.sessionTable = new dynamodb.Table(this, `SessionTable`, {
      tableName: `${ns}Session`,
      partitionKey: {
        name: 'accountId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sessionId',
        type: dynamodb.AttributeType.STRING,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const sessionFunction = new nodeLambda.NodejsFunction(this, `SessionFunction`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'session.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      timeout: cdk.Duration.seconds(5),
      functionName: `${ns}SessionFunction`,
      environment: {
        TABLE_NAME: this.sessionTable.tableName,
      },
    });
    sessionFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:*'],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));
    this.sessionTable.grantReadWriteData(sessionFunction);
    const sessionIntegration = new integrations.LambdaProxyIntegration({
      handler: sessionFunction,
    });
    props.httpApi.addRoutes({
      path: '/start',
      methods: [apigwv2.HttpMethod.POST],
      integration: sessionIntegration,
    });
  }
}

class RuleEngine extends cdk.Construct {
  public readonly ruleFunction: lambda.IFunction;

  constructor(scope: cdk.Construct, id: string, props: RuleProps) {
    super(scope, id);
    this.ruleFunction = new nodeLambda.NodejsFunction(this, `RuleFunction`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'rule.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      timeout: cdk.Duration.seconds(5),
      functionName: `${ns}RuleFunction`,
      environment: {
        TABLE_NAME: props.sessionTable.tableName,
        QUEUE_URL: props.messageQueue.queueUrl,
      },
    });
    this.ruleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:*'],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));
    props.sessionTable.grantReadData(this.ruleFunction);
    props.messageQueue.grantSendMessages(this.ruleFunction);

    const ruleIntegration = new integrations.LambdaProxyIntegration({
      handler: this.ruleFunction,
    });
    props.httpApi.addRoutes({
      path: '/game',
      methods: [apigwv2.HttpMethod.POST],
      integration: ruleIntegration,
    });
  }
}

class GameEngine extends cdk.Construct {
  public readonly gameFunction: lambda.IFunction;

  constructor(scope: cdk.Construct, id: string, props: GameProps) {
    super(scope, id);

    this.gameFunction = new nodeLambda.NodejsFunction(this, `GameFunction`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'game.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      timeout: cdk.Duration.seconds(5),
      functionName: `${ns}GameFunction`,
      environment: {
        WS_ENDPOINT: props.wsApi.apiEndpoint,
        WS_STAGE: props.wsApiStage.stageName,
        QUEUE_URL: props.messageQueue.queueUrl,
      },
    });
    this.gameFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));
    this.gameFunction.grantInvoke(new iam.ServicePrincipal('sqs.amazonaws.com'));
    this.gameFunction.addEventSourceMapping('GameFunctionEventMapping', {
      eventSourceArn: props.messageQueue.queueArn,
      batchSize: 10,
    });
    props.messageQueue.grantConsumeMessages(this.gameFunction);
  }
}

export class InfraStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const wsApi = new WebsocketApi(this, `WebsocketApi`);
    const httpApi = new HttpApi(this, 'HttpApi');

    const sessionEngine = new SessionEngine(this, `SessionEngine`, {
      httpApi: httpApi.api,
    });

    const messageQueue = new sqs.Queue(this, `MessageQueue`, {
      queueName: `${ns}MessageQueue.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(1),
    });

    new RuleEngine(this, `RuleEngine`, {
      httpApi: httpApi.api,
      sessionTable: sessionEngine.sessionTable,
      messageQueue,
    });

    new GameEngine(this, `GameEngine`, {
      wsApi: wsApi.api,
      wsApiStage: wsApi.stage,
      messageQueue,
    });
  }

}
