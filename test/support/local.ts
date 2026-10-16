/**
 * Shared setup for tests against the local engines in docker-compose.yml.
 * Clients reach them through the standard AWS_ENDPOINT_URL_<SERVICE> variables, the
 * same way the app code would; nothing in app/ knows about local engines.
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';

process.env.AWS_ENDPOINT_URL_DYNAMODB ??= 'http://localhost:8015';
process.env.AWS_ENDPOINT_URL_SFN ??= 'http://localhost:18015';
process.env.AWS_REGION ??= 'us-east-1';
// Placeholder credentials. The local engines accept anything.
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';

export const TABLE = 'nightly-orders-test';

export async function waitFor(what: string, check: () => Promise<unknown>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`${what} not reachable: ${String(last)}. Run "npm run local:up" first.`);
}

export async function freshTable(ddb: DynamoDBClient): Promise<void> {
  try {
    await ddb.send(new DeleteTableCommand({ TableName: TABLE }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  // Same key schema as the stack's Orders table.
  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    }),
  );
}
