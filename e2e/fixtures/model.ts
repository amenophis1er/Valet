/*
 * A scripted model: an OpenAI-compatible server whose "model" follows a fixed
 * plan, reading refs and observation ids from the tool results it is sent —
 * the same protocol a real provider speaks, so the whole loop runs for real.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

type Message = { role: string; content?: string | null; tool_calls?: unknown[] };
type Observation = { id: string; url: string; targets: Array<{ ref: string; role: string; name: string }> };
type StepResult = { call?: Record<string, unknown>; text?: string; /** The tool to call; default browser. */ tool?: string };
export type Step = (context: { observation?: Observation; messages: Message[] }) => StepResult | Promise<StepResult>;

export interface ScriptedModel {
  base: string;
  requests: Array<{ messages: Message[]; tools?: unknown[] }>;
  /** The Origin header of every request, or null when it had none. */
  origins: Array<string | null>;
  /** Start a new script (and a new request log) for the next run. */
  script(steps: Step[]): void;
  close(): Promise<void>;
}

function latestObservation(messages: Message[]): Observation | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const result = JSON.parse(message.content) as { observation?: Observation };
      if (result.observation?.targets) return result.observation;
    } catch { /* not JSON */ }
  }
  return undefined;
}

function sse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

export async function startModel(steps: Step[]): Promise<ScriptedModel> {
  const requests: ScriptedModel['requests'] = [];
  const origins: ScriptedModel['origins'] = [];
  let turn = 0;
  let plan = steps;
  const server = createServer((req, res) => {
    origins.push(typeof req.headers.origin === 'string' ? req.headers.origin : null);
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', object: 'model' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const request = JSON.parse(body) as { messages: Message[]; tools?: unknown[] };
      requests.push(request);
      const step: Step = plan[turn] ?? (() => ({ text: 'Done.' }));
      turn += 1;
      const { call, text, tool } = await step({ observation: latestObservation(request.messages), messages: request.messages });
      res.setHeader('content-type', 'text/event-stream');
      // Text and a call together, the way a real model says why before it acts.
      const delta = call
        ? { ...(text ? { content: text } : {}), tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: tool ?? 'browser', arguments: JSON.stringify(call) } }] }
        : { content: text ?? '' };
      res.end(sse([
        { choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
      ]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    origins,
    script: (next) => { plan = next; turn = 0; requests.length = 0; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The ref of the first target matching a role and a name pattern. */
export function refOf(observation: Observation | undefined, role: RegExp, name: RegExp): string {
  const target = observation?.targets.find((candidate) => role.test(candidate.role) && name.test(candidate.name));
  if (!target) throw new Error(`No ${role} named ${name} in the observation`);
  return target.ref;
}
