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

class WebsocketApi extends cdk.Construct {
  public api: apigwv2.CfnApi;

  constructor(scope: cdk.Construct, id: string) {
    super(scope, id);
    
    /*
    new iam.Role(this, 'ApiGatewayLoggingRole', {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        { managedPolicyArn: "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs" },
      ]
    });
    */

    this.api = new apigwv2.CfnApi(this, id, {
      name: 'WsApi',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });
    new cdk.CfnOutput(this, `${id}Url`, {
      exportName: 'WsApiUrl',
      value: `${this.api.attrApiEndpoint}`,
    });

    const credentialsRole = new iam.Role(this, `FunctionExecutionRole`, {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AWSLambdaFullAccess' },
      ],
    });
    const connectFunction = new nodeLambda.NodejsFunction(this, `ConnectFunction`, {
      entry: path.resolve(__dirname, 'functions', 'websocket', 'connect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'Connect',
    });
    const connectInteg = new apigwv2.CfnIntegration(this, `ConnectIntegration`, {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:ap-northeast-2:lambda:path/2015-03-31/functions/${connectFunction.functionArn}/invocations`,
      credentialsArn: credentialsRole.roleArn,
    });
    new apigwv2.CfnRoute(this, `ConnectRoute`, {
      apiId: this.api.ref,
      routeKey: '$connect',
      operationName: 'ConnectRoute',
      target: `integrations/${connectInteg.ref}`,
    });

    const disconnectFunction = new nodeLambda.NodejsFunction(this, `DisconnectFunction`, {
      entry: path.resolve(__dirname, 'functions', 'websocket', 'disconnect.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'Disconnect',
    });
    const disconnectInteg = new apigwv2.CfnIntegration(this, `DisconnectIntegration`, {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:ap-northeast-2:lambda:path/2015-03-31/functions/${disconnectFunction.functionArn}/invocations`,
      credentialsArn: credentialsRole.roleArn,
    });
    new apigwv2.CfnRoute(this, `DisconnectRoute`, {
      apiId: this.api.ref,
      routeKey: '$disconnect',
      operationName: 'DisconnectRoute',
      target: `integrations/${disconnectInteg.ref}`,
    });
  }
}

class HttpApi extends cdk.Construct {
  public api: apigwv2.HttpApi;

  constructor(scope: cdk.Construct, id: string) {
    super(scope, id);

    this.api = new apigwv2.HttpApi(this, id, {
      apiName: `GameApi`,
      corsPreflight: {
        allowHeaders: ['Authorization'],
        allowMethods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST, apigwv2.HttpMethod.OPTIONS],
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
  public sessionTable: dynamodb.Table;

  constructor(scope: cdk.Construct, id: string, props: SessionProps) {
    super(scope, id);

    this.sessionTable = new dynamodb.Table(this, `SessionTable`, {
      tableName: 'Session',
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
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'SessionFunction',
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
  public ruleFunction: lambda.IFunction;

  constructor(scope: cdk.Construct, id: string, props: RuleProps) {
    super(scope, id);
    this.ruleFunction = new nodeLambda.NodejsFunction(this, `RuleFunction`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'rule.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'RuleFunction',
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
  public gameFunction: lambda.IFunction;

  constructor(scope: cdk.Construct, id: string, props: GameProps) {
    super(scope, id);

    this.gameFunction = new nodeLambda.NodejsFunction(this, `GameFunction`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'game.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'GameFunction',
      environment: {
        WS_ENDPOINT: props.wsApi.attrApiEndpoint,
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
      queueName: 'MessageQueue.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(1),
    });

    const ruleEngine = new RuleEngine(this, `RuleEngine`, {
      httpApi: httpApi.api,
      sessionTable: sessionEngine.sessionTable,
      messageQueue,
    });

    const gameEngine = new GameEngine(this, `GameEngine`, {
      wsApi: wsApi.api,
      messageQueue,
    });
  }

}
