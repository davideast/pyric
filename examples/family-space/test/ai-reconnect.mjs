import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.fixtureTraffic = [];
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, transfer) {
      if (message?.kinControl === 'attach-ai') {
        window.fixtureTraffic.push({kind:'attach'});
        transfer[0].close();
        const channel = new MessageChannel();
        window.disconnectTestBackend = () => channel.port2.close();
        channel.port2.onmessage = ({data:m}) => {
          window.fixtureTraffic.push({kind:m.t,method:m.method,target:m.target?.service});
          if(m.method === 'getRuntimeEpoch') channel.port2.postMessage({t:'res',id:m.id,ok:true,value:{version:'fixture'}});
          if(m.t !== 'sub') return;
          const prompt=JSON.stringify(m.request);
          const stage=prompt.match(/WORKFLOW_STAGE: ([\w-]+)/)?.[1];
          const text=stage==='plan' ? JSON.stringify({mode:'family-trust',summary:'Shared notes',requirements:[],recordSchema:{},modules:['auth'],capabilities:[]}) : stage==='ui' ? JSON.stringify({needs:['persistent records','layout','feedback'],ids:['persistent-records']}) : "export default function App(){return <h1>Reconnected build</h1>}";
          channel.port2.postMessage({t:'snap',subId:m.subId,value:{chunk:{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}]}}});
          channel.port2.postMessage({t:'snap',subId:m.subId,value:{done:true}});
        };
        return post.call(this,message,[channel.port1]);
      }
      return post.call(this,message,transfer);
    };
  });
  const login = await context.newPage();
  await login.goto(process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/");
  await login.getByLabel("Email", { exact: true }).fill("emma@kin.example");
  await login
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  const [page] = await Promise.all([
    context.waitForEvent("page"),
    login.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  await login.close();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => console.log("PAGE", e.message));
  await page.evaluate(async () => {
    (await import('/durable-generation.ts')).generationClient();
    window.disconnectTestBackend();
  });
  await page.goto(new URL("/#apps", page.url()).href);
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByLabel("App name", { exact: true })
    .pressSequentially("Generated notes", { delay: 10 });
  await page
    .getByLabel("What should it do?", { exact: true })
    .fill("A shared family notes board.");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Sam Parker", exact: true }).check();
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("link", { name: "Open app", exact: false })
    .first()
    .waitFor({ timeout: 20000 })
    .catch(async (e) => {
      console.log(await page.locator("main").innerText());
      console.log(await page.evaluate(()=>window.fixtureTraffic));
      throw e;
    });
  console.log('PASS reload replaces a dead AI port and completes the build');
} finally {
  await browser.close();
}
