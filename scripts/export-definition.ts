/**
 * Writes build/nightly-digest.asl.json: the state machine exactly as CDK synthesizes it,
 * with placeholder ARNs. Feed it to the transition counter or paste it into Workflow Studio.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NightlyStack } from '../infra/lib/nightly-stack';
import { definitionFromTemplate } from '../tools/definition';

const stack = new NightlyStack(new cdk.App(), 'Export');
const definition = definitionFromTemplate(Template.fromStack(stack).toJSON() as never);
const out = path.join(__dirname, '..', 'build', 'nightly-digest.asl.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(definition, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)}`);
