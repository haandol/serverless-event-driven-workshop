#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { InfraStack } from '../lib/infra-stack';
import { ns } from '../lib/interfaces/config';

const app = new cdk.App();
new InfraStack(app, `${ns}InfraStack`);
