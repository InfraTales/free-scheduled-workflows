/**
 * Turns the DefinitionString of a synthesized state machine (a CloudFormation Fn::Join
 * with Ref and Fn::GetAtt inside) into plain Amazon States Language, with placeholder
 * values for the parts only CloudFormation knows. Used by the transition counter and
 * by the Step Functions Local tests, so both look at exactly what CDK will deploy.
 */

type Template = { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };

export const PLACEHOLDER_ACCOUNT = '123456789012';
export const PLACEHOLDER_REGION = 'us-east-1';

export interface ResolveOptions {
  /** Logical ID -> value for Ref. Defaults to the logical ID itself. */
  refs?: Record<string, string>;
}

function resolve(value: unknown, template: Template, opts: ResolveOptions): string {
  if (typeof value === 'string') return value;
  const v = value as Record<string, unknown>;
  if ('Fn::Join' in v) {
    const [sep, parts] = v['Fn::Join'] as [string, unknown[]];
    return parts.map((p) => resolve(p, template, opts)).join(sep);
  }
  if ('Ref' in v) {
    const id = v.Ref as string;
    if (id === 'AWS::Partition') return 'aws';
    if (id === 'AWS::Region') return PLACEHOLDER_REGION;
    if (id === 'AWS::AccountId') return PLACEHOLDER_ACCOUNT;
    return opts.refs?.[id] ?? id;
  }
  if ('Fn::GetAtt' in v) {
    const [id, attr] = v['Fn::GetAtt'] as [string, string];
    const type = template.Resources[id]?.Type;
    if (type === 'AWS::Lambda::Function' && attr === 'Arn') {
      return `arn:aws:lambda:${PLACEHOLDER_REGION}:${PLACEHOLDER_ACCOUNT}:function:${opts.refs?.[id] ?? id}`;
    }
    throw new Error(`no placeholder for ${id}.${attr} (${type ?? 'unknown type'})`);
  }
  throw new Error(`can't resolve ${JSON.stringify(value)}`);
}

/** The ASL of the only (or the named) state machine in a synthesized template. */
export function definitionFromTemplate(template: Template, opts: ResolveOptions = {}, logicalId?: string): Record<string, unknown> {
  const machines = Object.entries(template.Resources).filter(([id, r]) =>
    r.Type === 'AWS::StepFunctions::StateMachine' && (logicalId === undefined || id === logicalId),
  );
  if (machines.length !== 1) throw new Error(`expected one state machine, found ${machines.length}`);
  return JSON.parse(resolve(machines[0]![1].Properties.DefinitionString, template, opts)) as Record<string, unknown>;
}
