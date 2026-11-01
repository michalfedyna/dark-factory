// OpenAI wire formats only. Scenarios use the same normalized request/reply.
export function decodeRequest(input) {
  const messages = input.messages ?? input.input;
  const userTexts = messages
    .filter((item) => item.role === 'user')
    .map((item) =>
      typeof item.content === 'string'
        ? item.content
        : (item.content ?? []).map((part) => part.text ?? '').join(''),
    );
  let payload;
  for (const text of userTexts) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Exploration starts with plain issue text.
    }
  }
  return {
    model: input.model,
    tools: (input.tools ?? []).map((tool) => tool.name ?? tool.function?.name),
    payload,
    messageCount: messages.length,
    toolResults: messages.filter(
      (item) => item.role === 'tool' || item.type === 'function_call_output',
    ).length,
  };
}

export function statelessResponsesError(input, mode) {
  if (input.input.some((item) => item.type === 'item_reference'))
    return 'Items are not persisted when store is false.';
  if (input.store !== false) return 'Responses requests must set store: false.';
  if (input.previous_response_id || input.conversation)
    return 'Server-side conversations are not supported.';
  if (!input.include?.includes('reasoning.encrypted_content'))
    return 'Request encrypted reasoning for stateless replay.';
  const reasoning = input.input.filter((item) => item.type === 'reasoning');
  const calls = input.input.filter((item) => item.type === 'function_call');
  const results = input.input.filter(
    (item) => item.type === 'function_call_output',
  );
  if (
    results.some(
      (result) => !calls.some((call) => call.call_id === result.call_id),
    )
  )
    return 'Tool results must include the original function calls.';
  if (mode === 'no-encrypted-reasoning') {
    if (reasoning.length) return 'Do not replay reasoning without encryption.';
  } else if (
    calls.some((call) => {
      const sequence = call.call_id.split('-').at(-1);
      return !reasoning.some(
        (item) =>
          item.id === `rs-test-${sequence}` &&
          item.encrypted_content === `encrypted-test-${sequence}`,
      );
    })
  )
    return 'Preserve encrypted reasoning alongside each function call.';
}

export function encodeReply(url, request, reply, mode) {
  const output = reply.tool ? undefined : JSON.stringify(reply.result);
  const toolId = `call-${reply.tool?.name ?? 'result'}-${request.messageCount}`;
  if (url === '/v1/chat/completions')
    return {
      id: 'completion-test',
      object: 'chat.completion',
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          message: reply.tool
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: toolId,
                    type: 'function',
                    function: {
                      name: reply.tool.name,
                      arguments: JSON.stringify(reply.tool.args),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: output },
          finish_reason: reply.tool ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
  if (url === '/v1/responses')
    return {
      id: 'resp-test',
      model: request.model,
      created_at: 1,
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: `rs-test-${request.messageCount}`,
          summary: [
            { type: 'summary_text', text: 'Offline reasoning summary.' },
          ],
          ...(mode === 'no-encrypted-reasoning'
            ? {}
            : { encrypted_content: `encrypted-test-${request.messageCount}` }),
        },
        ...(reply.tool
          ? [
              {
                type: 'message',
                id: `msg-test-${request.messageCount}`,
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'Continuing with a tool.',
                    annotations: [],
                  },
                ],
              },
            ]
          : []),
        reply.tool
          ? {
              type: 'function_call',
              id: `fc-test-${request.messageCount}`,
              call_id: toolId,
              name: reply.tool.name,
              arguments: JSON.stringify(reply.tool.args),
              status: 'completed',
            }
          : {
              type: 'message',
              id: `msg-test-${request.messageCount}`,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: output, annotations: [] }],
            },
      ],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    };
  throw new Error(`Unsupported provider URL: ${url}`);
}

// Streaming uses the same scenario results as non-streaming requests.
export function encodeStreamReply(url, request, reply, mode) {
  const response = encodeReply(url, request, reply, mode);
  const parts = (text) => text.match(/.{1,24}/gs) ?? [];
  if (url === '/v1/chat/completions') {
    const chunk = (delta, finishReason = null) => ({
      id: response.id,
      object: 'chat.completion.chunk',
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    const message = response.choices[0].message;
    const chunks = [chunk({ role: 'assistant' })];
    if (reply.tool) {
      const tool = message.tool_calls[0];
      chunks.push(
        chunk({
          tool_calls: [
            {
              index: 0,
              ...tool,
              function: { name: tool.function.name, arguments: '' },
            },
          ],
        }),
      );
      for (const text of parts(tool.function.arguments))
        chunks.push(
          chunk({ tool_calls: [{ index: 0, function: { arguments: text } }] }),
        );
    } else {
      for (const text of parts(message.content))
        chunks.push(chunk({ content: text }));
    }
    chunks.push(chunk({}, reply.tool ? 'tool_calls' : 'stop'));
    chunks.push({ ...chunk({}), choices: [], usage: response.usage });
    return chunks;
  }
  const chunks = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
  ];
  for (const [index, item] of response.output.entries()) {
    chunks.push({
      type: 'response.output_item.added',
      output_index: index,
      item: {
        ...item,
        ...(item.type === 'function_call' ? { arguments: '' } : {}),
      },
    });
    if (item.type === 'reasoning') {
      chunks.push({
        type: 'response.reasoning_summary_part.added',
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
      chunks.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        delta: item.summary[0].text,
      });
    } else if (item.type === 'message') {
      for (const text of parts(item.content[0].text))
        chunks.push({
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: index,
          content_index: 0,
          delta: text,
        });
    } else if (item.type === 'function_call') {
      for (const text of parts(item.arguments))
        chunks.push({
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: index,
          delta: text,
        });
    }
    chunks.push({
      type: 'response.output_item.done',
      output_index: index,
      item,
    });
  }
  chunks.push({ type: 'response.completed', response });
  return chunks;
}
