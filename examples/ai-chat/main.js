// A chat app written against the upstream Firebase AI API: 'firebase/app'
// and 'firebase/ai' are the ONLY imports. Under `pyric dev` the import map
// serves the pyric mirror for these; the same file, built for production,
// talks to real Firebase AI.
import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, Schema, FunctionCallingMode } from 'firebase/ai';

// ── Engine selection (URL-driven) ──────────────────────────────────────────
const params = new URLSearchParams(location.search);
const mode = params.get('engine') === 'local' ? 'local' : 'scripted';
const localModel = params.get('model') ?? 'qwen3:4b';

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE PYRIC-SPECIFIC EXTENSION IN THIS FILE.
//
// `getAI`'s `engine` option is a pyric extension that only sandbox targets
// read (upstream firebase/ai ignores unknown options, so this same call is
// production-safe). It picks how the sandbox ANSWERS:
//
//   scripted  deterministic and zero-network: scripted entries below answer
//             matching prompts once each; everything else gets a synthesized
//             wire-true response. No Google endpoint is ever contacted.
//
//   openai    a real local model: requests go to serve's same-origin
//             /__pyric/ai-proxy route, which forwards to an OpenAI-compatible
//             server (default upstream http://localhost:11434/v1, i.e.
//             Ollama). `model` names the upstream model to run.
//
// Every other line of this app is the plain upstream firebase/ai API.
// ═══════════════════════════════════════════════════════════════════════════
const engine =
  mode === 'local'
    ? { kind: 'openai', baseUrl: '/__pyric/ai-proxy', model: localModel }
    : {
        kind: 'scripted',
        script: [
          {
            match: 'hello',
            respond: {
              chunks: ['Hello', ' from', ' the', ' scripted', ' engine.', ' Deterministic,', ' zero', ' network.'],
            },
          },
          // The weather round trip: first matching call gets the function
          // call, the follow-up (same last user turn) gets the answer.
          { match: 'weather', respond: { functionCall: { name: 'get_weather', args: { city: 'Lisbon' } } } },
          { match: 'weather', respond: { text: 'Right now in Lisbon: sunny and 24°C. Scripted round trip complete.' } },
        ],
      };

// ── The app, exactly as it would be written against real Firebase ─────────
const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-project' });
const ai = getAI(app, { engine });
const model = getGenerativeModel(ai, { model: 'gemini-flash-lite-latest' });
const chat = model.startChat();

// ── UI plumbing ────────────────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const weatherEl = document.getElementById('weather');
const statusEl = document.getElementById('status');
const engineSelect = document.getElementById('engine');
const engineLabel = document.getElementById('engine-label');

engineSelect.value = mode;
engineLabel.textContent =
  mode === 'local' ? `openai via /__pyric/ai-proxy (${localModel})` : 'scripted (zero network)';
engineSelect.addEventListener('change', () => {
  const next = new URLSearchParams(location.search);
  next.set('engine', engineSelect.value);
  location.search = next.toString();
});

function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.role = role;
  el.textContent = text;
  messagesEl.append(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function setBusy(busy) {
  sendEl.disabled = busy;
  weatherEl.disabled = busy;
  statusEl.textContent = busy ? 'thinking…' : '';
}

function showError(el, err) {
  el.classList.add('error');
  el.textContent = String(err?.message ?? err);
  el.dataset.done = 'true';
}

// ── Chat: streaming turns with history via ChatSession ─────────────────────
async function send(text) {
  addMsg('user', text);
  const el = addMsg('model', '');
  setBusy(true);
  try {
    const result = await chat.sendMessageStream(text);
    for await (const chunk of result.stream) {
      const calls = chunk.functionCalls();
      if (calls) {
        el.textContent += calls.map((c) => `[function call] ${c.name}(${JSON.stringify(c.args)})`).join('\n');
      }
      el.textContent += chunk.text();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    el.dataset.done = 'true';
  } catch (err) {
    showError(el, err);
  } finally {
    setBusy(false);
  }
}

// ── Function calling: a get_weather tool, full round trip ──────────────────
const weatherTool = {
  functionDeclarations: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: Schema.object({
        properties: { city: Schema.string({ description: 'City name' }) },
      }),
    },
  ],
};

// The app's own tool implementation: a local stub the model's call runs through.
function getWeather({ city }) {
  return { city: city ?? 'Lisbon', temperatureC: 24, condition: 'sunny' };
}

async function weatherDemo() {
  const question = 'What is the weather in Lisbon right now?';
  addMsg('user', question);
  setBusy(true);
  try {
    // Turn 1: mode ANY requires the model to call the declared tool.
    const first = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: question }] }],
      tools: [weatherTool],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingMode.ANY, allowedFunctionNames: ['get_weather'] },
      },
    });
    const call = first.response.functionCalls()?.[0];
    if (!call) {
      // Some local models ignore forced tool choice; render what came back.
      const el = addMsg('model', first.response.text() || '(the model answered without calling the tool)');
      el.dataset.done = 'true';
      return;
    }

    // Run the tool locally and show the round trip.
    const result = getWeather(call.args);
    addMsg('tool', `${call.name}(${JSON.stringify(call.args)}) => ${JSON.stringify(result)}`);

    // Turn 2: thread the model's functionCall turn and the tool result back.
    const second = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: question }] },
        first.response.candidates[0].content,
        { role: 'function', parts: [{ functionResponse: { name: call.name, response: result } }] },
      ],
      tools: [weatherTool],
    });
    const el = addMsg('model', second.response.text());
    el.dataset.done = 'true';
  } catch (err) {
    showError(addMsg('model', ''), err);
  } finally {
    setBusy(false);
  }
}

// ── Wire up ────────────────────────────────────────────────────────────────
document.getElementById('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || sendEl.disabled) return;
  inputEl.value = '';
  void send(text);
});
weatherEl.addEventListener('click', () => void weatherDemo());
