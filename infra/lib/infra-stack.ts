import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as apigwv2 from '@aws-cdk/aws-apigatewayv2';
import * as integrations from '@aws-cdk/aws-apigatewayv2-integrations';
import * as lambda from '@aws-cdk/aws-lambda';
import * as nodeLambda from '@aws-cdk/aws-lambda-nodejs';
import * as sqs from '@aws-cdk/aws-sqs';
import * as dynamodb from '@aws-cdk/aws-dynamodb';

export class InfraStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const wsApi = new apigwv2.CfnApi(this, `WebsocketApi`, {
      name: 'WebsocketApi',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });
    const wsApiDevStage = new apigwv2.CfnStage(this, `WebsocketDevStage`, {
      apiId: wsApi.ref,
      stageName: 'dev',
      autoDeploy: true,
      defaultRouteSettings: {
        dataTraceEnabled: true,
        loggingLevel: 'INFO',
      }
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
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:ap-northeast-2:lambda:path/2015-03-31/functions/${connectFunction.functionArn}/invocations`,
      credentialsArn: credentialsRole.roleArn,
    });
    new apigwv2.CfnRoute(this, `ConnectRoute`, {
      apiId: wsApi.ref,
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
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:ap-northeast-2:lambda:path/2015-03-31/functions/${disconnectFunction.functionArn}/invocations`,
      credentialsArn: credentialsRole.roleArn,
    });
    new apigwv2.CfnRoute(this, `DisconnectRoute`, {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      operationName: 'DisconnectRoute',
      target: `integrations/${disconnectInteg.ref}`,
    });

    const httpApi = new apigwv2.HttpApi(this, `HttpApi`, {
      apiName: `GameApi`,
      corsPreflight: {
        allowHeaders: ['Authorization'],
        allowMethods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST, apigwv2.HttpMethod.OPTIONS],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(10),
      },
    });
    new apigwv2.HttpStage(this, 'HttpStage', {
      httpApi,
      stageName: 'dev',
    });

    const sessionTable = new dynamodb.Table(this, `SessionTable`, {
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
    const sessionEngine = new nodeLambda.NodejsFunction(this, `SessionEngine`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'session.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'SessionEngine',
      environment: {
        TABLE_NAME: sessionTable.tableName,
      },
    });
    sessionEngine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:*'],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));
    sessionTable.grantReadWriteData(sessionEngine);
    const sessionIntegration = new integrations.LambdaProxyIntegration({
      handler: sessionEngine,
    });
    httpApi.addRoutes({
      path: '/start',
      methods: [apigwv2.HttpMethod.POST],
      integration: sessionIntegration,
    });

    const messageQueue = new sqs.Queue(this, `MessageQueue`, {
      queueName: 'MessageQueue.fifo', 
      retentionPeriod: cdk.Duration.days(1),
      fifo: true,
    });
    const ruleEngine = new nodeLambda.NodejsFunction(this, `RuleEngine`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'rule.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'RuleEngine',
      environment: {
        TABLE_NAME: sessionTable.tableName,
        QUEUE_URL: messageQueue.queueUrl,
      },
    });
    ruleEngine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:*'],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));
    sessionTable.grantReadData(ruleEngine);
    messageQueue.grantSendMessages(ruleEngine);
    const ruleIntegration = new integrations.LambdaProxyIntegration({
      handler: ruleEngine,
    });
    httpApi.addRoutes({
      path: '/game',
      methods: [apigwv2.HttpMethod.POST],
      integration: ruleIntegration,
    });

    const gameEngine = new nodeLambda.NodejsFunction(this, `GameEngine`, {
      entry: path.resolve(__dirname, 'functions', 'engine', 'game.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(5),
      functionName: 'GameEngine',
      environment: {
        WS_ENDPOINT: wsApi.attrApiEndpoint,
        WS_STAGE: wsApiDevStage.stageName,
        QUEUE_URL: messageQueue.queueUrl,
      },
    });
    gameEngine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));
    gameEngine.grantInvoke(new iam.ServicePrincipal('sqs.amazonaws.com'));
    messageQueue.grantConsumeMessages(gameEngine);
    gameEngine.addEventSourceMapping('GameEngineEventMapping', {
      eventSourceArn: messageQueue.queueArn, 
      batchSize: 10,
    });
  }

}
