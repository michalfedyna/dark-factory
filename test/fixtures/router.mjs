// A local OpenAI-compatible endpoint for offline integration tests. Never used
// by the application. It exercises real Mastra tool execution and extraction.
import { createServer } from 'node:http';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers';

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
    if (mode === 'exit-after-models' && modelRequests === 1) {
      setTimeout(() => {
        process.exit(2);
      }, 250);
    }
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => {
    chunks.push(chunk);
  });
  request.on('end', () => {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (input.model !== 'gpt-6.1-sol') {
      response.writeHead(400).end('Wrong model ID');
      return;
    }
    const question = {
      question: 'Which export format?',
      context: 'Choose a format for the filtered issues.',
      options: ['CSV', 'JSON'],
    };
    const output = resultPath ? readFileSync(resultPath, 'utf8') : '{}';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/v1/chat/completions') {
      const answered = input.messages.some(
        (message) => message.role === 'tool',
      );
      response.end(
        JSON.stringify({
          id: 'completion-test',
          object: 'chat.completion',
          created: 1,
          model: input.model,
          choices: [
            {
              index: 0,
              message: answered
                ? { role: 'assistant', content: output }
                : {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-question',
                        type: 'function',
                        function: {
                          name: 'ask',
                          arguments: JSON.stringify(question),
                        },
                      },
                    ],
                  },
              finish_reason: answered ? 'stop' : 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
      return;
    }
    if (request.url === '/v1/responses') {
      const answered = input.input.some(
        (item) => item.type === 'function_call_output',
      );
      const item = answered
        ? {
            type: 'message',
            id: 'msg-test',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: output, annotations: [] }],
          }
        : {
            type: 'function_call',
            id: 'fc-test',
            call_id: 'call-question',
            name: 'ask',
            arguments: JSON.stringify(question),
            status: 'completed',
          };
      response.end(
        JSON.stringify({
          id: 'resp-test',
          model: input.model,
          created_at: 1,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        }),
      );
      return;
    }
    response.end();
  });
});
server.listen(Number(port), '127.0.0.1');
process.on('SIGTERM', () => {
  server.close();
  server.closeAllConnections();
});
