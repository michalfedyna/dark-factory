// Offline endpoint exercising real Mastra tool execution and extraction.
import { createServer } from 'node:http';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers';
import {
  decodeRequest,
  encodeReply,
  statelessResponsesError,
} from './provider-protocol.mjs';
import { requestRole, scenarioReply } from './provider-scenario.mjs';

const [port, resultPath, mode = 'normal'] = process.argv.slice(2);
let modelRequests = 0;
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer test-key') {
    response.writeHead(401).end();
    return;
  }
  if (request.url === '/v1/models') {
    modelRequests++;
    if (mode === 'unready') {
      response.writeHead(503).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Test-Model-Requests', String(modelRequests));
    let data = [{ id: 'gpt-6.1-sol' }];
    if (
      mode === 'empty-catalog' ||
      (mode === 'delayed-catalog' && modelRequests <= 2)
    )
      data = [];
    if (
      mode === 'missing-model' ||
      (mode === 'delayed-model' && modelRequests <= 2)
    )
      data = [{ id: 'other-model' }];
    response.end(JSON.stringify({ data }));
    if (mode === 'exit-after-models' && modelRequests === 1)
      setTimeout(() => {
        process.exit(2);
      }, 250);
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => {
    chunks.push(chunk);
  });
  request.on('end', async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const protocolError =
      request.url === '/v1/responses'
        ? statelessResponsesError(body, mode)
        : undefined;
    if (protocolError) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: protocolError } }));
      return;
    }
    const input = decodeRequest(body);
    const role = requestRole(input);
    if (resultPath && input.toolResults === 0)
      appendFileSync(
        join(dirname(resultPath), 'agent-contexts.jsonl'),
        `${JSON.stringify({ role, payload: input.payload, tools: input.tools })}\n`,
      );
    if (
      input.model !== 'gpt-6.1-sol' &&
      !(role === 'observer' && input.model === 'observer-model')
    ) {
      response.writeHead(400).end('Wrong model ID');
      return;
    }
    if (mode === 'slow-implementation' && role === 'implementation') {
      await new Promise((resolve) => {
        setTimeout(resolve, 10_000);
      });
    }
    if (role === 'observer' && mode === 'observer-failure') {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          error: { message: 'Authorization: Bearer test-key' },
        }),
      );
      return;
    }
    if (
      mode.startsWith('observer') &&
      role === 'exploration' &&
      (mode === 'observer' || !input.toolResults)
    ) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1_500);
      });
    }
    const reply = scenarioReply(input, resultPath, mode);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(encodeReply(request.url, input, reply, mode)));
  });
});
server.listen(Number(port), '127.0.0.1');
process.on('SIGTERM', () => {
  if (mode === 'ignore-term') return;
  server.close();
  server.closeAllConnections();
});
