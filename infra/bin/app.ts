#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NightlyStack } from '../lib/nightly-stack';
import { acknowledgeNagFindings } from '../lib/nag';

const app = new cdk.App();

// Optional: cdk deploy -c alertEmail=you@example.com -c timeZone=Europe/London -c hour=4 -c minute=15
const alertEmail: unknown = app.node.tryGetContext('alertEmail');
if (alertEmail !== undefined && (typeof alertEmail !== 'string' || !alertEmail.includes('@'))) {
  throw new Error(`alertEmail must be an email address, got ${JSON.stringify(alertEmail)}`);
}
const timeZone: unknown = app.node.tryGetContext('timeZone');
const hour: unknown = app.node.tryGetContext('hour');
const minute: unknown = app.node.tryGetContext('minute');

const stack = new NightlyStack(app, 'FreeScheduledWorkflows', {
  alertEmail,
  schedule: {
    ...(typeof timeZone === 'string' ? { timeZone } : {}),
    ...(hour !== undefined ? { hour: Number(hour) } : {}),
    ...(minute !== undefined ? { minute: Number(minute) } : {}),
  },
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});
acknowledgeNagFindings(stack);

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
