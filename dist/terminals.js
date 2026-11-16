import { spawn,                   } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const MAX_OUTPUT_CHARACTERS = 262_144;
export const DEFAULT_TAIL_CHARACTERS = 8_000;
export const MAX_TAIL_CHARACTERS = 64_000;
const MAX_RUNNING_TERMINALS = 16;
const MAX_RETAINED_EXITED = 20;

                                   
             
                  
              
                          
                    
                   
                          
                           
 

                                                        
                 
                 
                    
                     
 

                                                                       
                                                               
                                                                         

                           
             
                  
              
                      
                    
                 
                      
                           
                   
                          
                   
                         
                        
                         
                           
 

/**
 * Owns long-running shell processes that outlive a single tool call, such as
 * `php artisan serve`, `npm run dev`, or a file watcher. Output is retained in
 * a bounded ring buffer and can be read incrementally by absolute offset.
 */
export class BackgroundTerminals {
           #terminals = new Map                         ();
  #counter = 0;

  async start(command        , cwd        , options               = {})                        {
    const value = command.trim();
    if (!value) throw new Error("start a background terminal with a non-empty command");
    this.#prune();
    if (this.runningCount() >= MAX_RUNNING_TERMINALS) throw new Error(`at most ${MAX_RUNNING_TERMINALS} background terminals can run at once; stop one first`);
    const id = `term-${++this.#counter}`;
    const [shell, args] = shellCommand(value);
    const child = spawn(shell, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let markExited             ;
    const exited = new Promise      ((resolve) => { markExited = resolve; });
    const terminal                  = {
      id, command: value, cwd, child, startedAt: Date.now(),
      output: "", outputStart: 0, outputCharacters: 0,
      running: true, exitCode: null, settled: false, decoder: new StringDecoder("utf8"), exited, markExited,
    };
    this.#terminals.set(id, terminal);
    const capture = (chunk        )       => append(terminal, terminal.decoder.write(chunk));
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", (error) => { append(terminal, `\n[terminal error: ${error.message}]\n`); settle(terminal, null); });
    child.on("close", (code, signal) => {
      append(terminal, terminal.decoder.end());
      settle(terminal, typeof code === "number" ? code : signal ? -1 : 0);
    });
    if (options.signal?.aborted) {
      signalTree(child, "SIGKILL");
      settle(terminal, null);
      throw options.signal.reason;
    }
    return this.#waitForStartup(terminal, options.waitMs ?? 0, options.signal);
  }

  #waitForStartup(terminal                 , waitMs        , signal              )                        {
    const timeout = clamp(waitMs, 0, 5_000);
    return new Promise((resolve, reject) => {
      let done = false;
      let timer                            ;
      const cleanup = ()       => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const finish = ()       => { if (done) return; done = true; cleanup(); resolve(readSnapshot(terminal, {})); };
      const onAbort = ()       => {
        if (done) return;
        done = true;
        cleanup();
        void this.stop(terminal.id, { timeoutMs: 1_000 }).finally(() => reject(signal?.reason));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      terminal.exited.then(finish);
      if (timeout > 0) timer = setTimeout(finish, timeout);
      else finish();
    });
  }

  read(id        , options              = {})               {
    return readSnapshot(this.#require(id), options);
  }

  list()                     {
    return [...this.#terminals.values()].map(snapshot);
  }

  runningCount()         {
    return [...this.#terminals.values()].filter((terminal) => terminal.running).length;
  }

  async stop(id        , options              = {})                            {
    const terminal = this.#require(id);
    if (!terminal.running) return snapshot(terminal);
    if (options.signal?.aborted) {
      signalTree(terminal.child, "SIGKILL");
      await waitForExit(terminal, 1_000);
      return snapshot(terminal);
    }
    terminal.stopping ??= stopProcess(terminal, options.timeoutMs ?? 2_000, options.signal);
    await terminal.stopping;
    return snapshot(terminal);
  }

  /** Terminate every terminal and return how many were still running. */
  async stopAll()                  {
    const running = [...this.#terminals.values()].filter((terminal) => terminal.running);
    await Promise.all(running.map((terminal) => this.stop(terminal.id)));
    return running.length;
  }

  /** Best-effort synchronous teardown, used when the extension host unloads. */
  dispose()       {
    for (const terminal of this.#terminals.values()) {
      if (terminal.running) signalTree(terminal.child, "SIGKILL");
    }
    this.#terminals.clear();
  }

  #prune()       {
    const finished = [...this.#terminals.values()].filter((terminal) => !terminal.running);
    for (const terminal of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_EXITED))) this.#terminals.delete(terminal.id);
  }

  #require(id        )                  {
    const terminal = this.#terminals.get(id.trim());
    if (!terminal) throw new Error(`no background terminal named "${id}". Use the list action to see open terminals.`);
    return terminal;
  }
}

function snapshot(terminal                 )                   {
  return {
    id: terminal.id,
    command: terminal.command,
    cwd: terminal.cwd,
    pid: terminal.child.pid,
    startedAt: new Date(terminal.startedAt).toISOString(),
    running: terminal.running,
    exitCode: terminal.exitCode,
    outputCharacters: terminal.outputCharacters,
  };
}

function readSnapshot(terminal                 , options             )               {
  const tail = clamp(options.tail ?? DEFAULT_TAIL_CHARACTERS, 0, MAX_TAIL_CHARACTERS);
  const available = terminal.output.length;
  let startIndex        ;
  let truncated = false;
  if (options.offset !== undefined) {
    const offset = Math.max(0, Math.floor(options.offset));
    if (offset < terminal.outputStart) { truncated = true; startIndex = 0; }
    else startIndex = Math.min(available, offset - terminal.outputStart);
  } else {
    startIndex = Math.max(0, available - tail);
  }
  const endIndex = Math.min(available, startIndex + MAX_TAIL_CHARACTERS);
  return {
    ...snapshot(terminal),
    output: sanitize(terminal.output.slice(startIndex, endIndex)),
    offset: terminal.outputStart + startIndex,
    endOffset: terminal.outputStart + endIndex,
    truncated,
  };
}

function append(terminal                 , text        )       {
  if (!text) return;
  terminal.outputCharacters += text.length;
  terminal.output += text;
  if (terminal.output.length > MAX_OUTPUT_CHARACTERS) {
    terminal.output = terminal.output.slice(terminal.output.length - MAX_OUTPUT_CHARACTERS);
    terminal.outputStart = terminal.outputCharacters - terminal.output.length;
  }
}

function settle(terminal                 , exitCode               )       {
  if (terminal.settled) return;
  terminal.settled = true;
  terminal.running = false;
  terminal.exitCode = exitCode;
  terminal.markExited();
}

async function stopProcess(terminal                 , timeoutMs        , signal              )                {
  signalTree(terminal.child, "SIGTERM");
  if (await waitForExit(terminal, clamp(timeoutMs, 0, 10_000), signal)) return;
  signalTree(terminal.child, "SIGKILL");
  await waitForExit(terminal, 1_000);
}

function waitForExit(terminal                 , timeoutMs        , signal              )                   {
  if (!terminal.running) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let timer                            ;
    const cleanup = ()       => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const finish = (exited         )       => { if (done) return; done = true; cleanup(); resolve(exited); };
    const onAbort = ()       => finish(false);
    timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    terminal.exited.then(() => finish(true));
  });
}

function signalTree(child              , signal                )       {
  if (process.platform === "win32") {
    if (child.pid) {
      try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch { /* fall back to the direct child */ }
    }
    try { child.kill(signal); } catch { /* the process may already be gone */ }
    return;
  }
  if (child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through to the direct child */ }
  }
  try { child.kill(signal); } catch { /* the process may already be gone */ }
}

function shellCommand(command        )                     {
  return process.platform === "win32"
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-c", command]];
}

function sanitize(text        )         {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function clamp(value        , minimum        , maximum        )         {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function delay(ms        )                {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}


//# sourceURL=../src/terminals.ts