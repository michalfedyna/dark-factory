// A local OpenAI-compatible endpoint for offline integration tests. Never used
// by the application. It exercises real Mastra tool execution and extraction.
import { createServer } from 'node:http';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  request.on('end', async () => {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const isObserver = JSON.stringify(input).includes(
      'You are the DarkFactory progress observer.',
    );
    if (
      input.model !== 'gpt-6.1-sol' &&
      !(isObserver && input.model === 'observer-model')
    ) {
      response.writeHead(400).end('Wrong model ID');
      return;
    }
    if (isObserver && mode === 'observer-failure') {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          error: { message: 'Authorization: Bearer test-key' },
        }),
      );
      return;
    }
    if (
      mode.startsWith('observer') &&
      !isObserver &&
      JSON.stringify(input).includes(
        'You are the DarkFactory exploration agent.',
      ) &&
      (mode === 'observer' ||
        !(input.messages ?? input.input).some(
          (item) =>
            item.role === 'tool' || item.type === 'function_call_output',
        ))
    ) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1_500);
      });
    }
    const question = {
      question: 'Which export format?',
      context: 'Choose a format for the filtered issues.',
      options: ['CSV', 'JSON'],
    };
    const savedOutput = resultPath ? readFileSync(resultPath, 'utf8') : '{}';
    const delivery = isObserver
      ? progressReply(input)
      : mode.startsWith('delivery') ||
          JSON.stringify(input).includes('You inspect the current repository')
        ? deliveryReply(input, savedOutput, mode)
        : undefined;
    const output = delivery?.result
      ? JSON.stringify(delivery.result)
      : savedOutput;
    const toolName = delivery?.tool?.name ?? 'ask';
    const toolArgs = delivery?.tool?.args ?? question;
    const toolId = delivery
      ? `call-${toolName}-${input.messages ? input.messages.length : input.input.length}`
      : 'call-question';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/v1/chat/completions') {
      const answered = delivery
        ? !delivery.tool
        : input.messages.some((message) => message.role === 'tool');
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
                        id: toolId,
                        type: 'function',
                        function: {
                          name: toolName,
                          arguments: JSON.stringify(toolArgs),
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
      const answered = delivery
        ? !delivery.tool
        : input.input.some((item) => item.type === 'function_call_output');
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
            call_id: toolId,
            name: toolName,
            arguments: JSON.stringify(toolArgs),
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

function progressReply(input) {
  const message = (input.messages ?? input.input).find(
    (item) => item.role === 'user',
  );
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => part.text ?? '').join('');
  const snapshot = JSON.parse(text);
  const answered = snapshot.events.some(
    (event) =>
      event.kind === 'tool' &&
      event.agent === 'exploration' &&
      event.tool === 'ask' &&
      event.status === 'completed',
  );
  return {
    result: {
      summary: answered
        ? 'Clarification received; the brief is being prepared.'
        : 'Exploring the issue; no implementation has started.',
    },
  };
}

function deliveryReply(input, savedOutput, mode) {
  const serialized = JSON.stringify(input);
  const state = deliveryState(input);
  const prefix = `r${state?.round ?? 1}`;
  const tools = input.messages
    ? input.messages.filter((message) => message.role === 'tool').length
    : input.input.filter((item) => item.type === 'function_call_output').length;
  if (serialized.includes('You inspect the current repository'))
    return tools === 0
      ? {
          tool: {
            name: 'mastra_workspace_read_file',
            args: { path: 'package.json' },
          },
        }
      : {
          result: JSON.parse(
            readFileSync(
              join(dirname(resultPath), 'project-plan.json'),
              'utf8',
            ),
          ),
        };
  if (serialized.includes('You own implementation')) {
    return tools === 0
      ? {
          tool: {
            name: 'mastra_workspace_write_file',
            args: {
              path: 'feature.txt',
              content:
                state?.round > 0 ? 'implemented repaired' : 'implemented',
              overwrite: state?.round > 0,
            },
          },
        }
      : {
          result: {
            summary:
              'Implemented feature.txt and verified the configured check.',
            blockers: [],
          },
        };
  }
  if (serialized.includes('target-specific agent_browser and agent_device')) {
    const actions = [
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'open', args: [] },
      },
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'snapshot', args: [] },
      },
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'screenshot', args: [] },
      },
      {
        name: 'agent_device',
        args: { targetId: 'ios', operation: 'open', args: [] },
      },
      {
        name: 'agent_device',
        args: { targetId: 'ios', operation: 'snapshot', args: [] },
      },
      {
        name: 'agent_device',
        args: { targetId: 'ios', operation: 'screenshot', args: [] },
      },
    ];
    const failed = mode === 'delivery-qa-repair' && state?.round === 1;
    return tools < actions.length
      ? { tool: actions[tools] }
      : {
          result: {
            verdict: failed ? 'changes-requested' : 'pass',
            criteria: [
              {
                id: 'AC1',
                status: failed ? 'fail' : 'pass',
                evidenceIds: [`${prefix}-e1`, `${prefix}-e5`, `${prefix}-e8`],
                notes: 'Offline test checks and stub UI journeys completed.',
              },
            ],
            findings: failed
              ? [
                  {
                    source: 'qa',
                    kind: 'defect',
                    severity: 'blocking',
                    description: 'Repair the initial candidate.',
                    criterionId: 'AC1',
                    evidenceIds: [`${prefix}-e1`],
                  },
                ]
              : [],
          },
        };
  }
  if (serialized.includes('Inspect the supplied patch and source yourself')) {
    const failed = mode === 'delivery-review-repair' && state?.round === 1;
    return tools === 0
      ? {
          tool: {
            name: 'mastra_workspace_read_file',
            args: { path: 'feature.txt' },
          },
        }
      : {
          result: {
            verdict: failed ? 'changes-requested' : 'pass',
            summary: 'Independently inspected feature.txt and the patch.',
            findings: failed
              ? [
                  {
                    source: 'review',
                    kind: 'defect',
                    severity: 'blocking',
                    description: 'Repair the initial implementation.',
                    criterionId: 'AC1',
                    evidenceIds: [`${prefix}-e1`],
                  },
                ]
              : [],
          },
        };
  }
  if (serialized.includes('Prepare a concise factual pull request summary'))
    return {
      result: {
        title: 'feat: implement approved issue',
        changes: ['Add feature.txt.'],
        testing: ['Configured check and offline web/mobile QA passed.'],
        limitations: ['UI automation is stubbed in this offline test.'],
      },
    };
  return tools === 0
    ? {
        tool: {
          name: 'ask',
          args: {
            question: 'Which export format?',
            context: '',
            options: ['CSV', 'JSON'],
          },
        },
      }
    : { result: JSON.parse(savedOutput) };
}

function deliveryState(input) {
  for (const message of input.messages ?? input.input) {
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? '').join('');
    try {
      const payload = JSON.parse(text);
      if (payload.state) return payload.state;
    } catch {
      // Exploration starts with plain issue text, not a delivery payload.
    }
  }
  return undefined;
}
server.listen(Number(port), '127.0.0.1');
process.on('SIGTERM', () => {
  server.close();
  server.closeAllConnections();
});
