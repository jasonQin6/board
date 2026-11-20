"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { start } from "@/lib/client";
import { ABOUT_SCENARIO, DEFAULTS, MAX_AGENTS, MAX_MINUTES, SCENARIOS, type Scenario } from "@/lib/config";
import { perMillion, type Model } from "@/lib/models";

/** Models by provider, the part of the ID before its `/`, in the order they're listed. */
function providers(models: Model[]): [string, Model[]][] {
  const by = new Map<string, Model[]>();
  for (const entry of models) {
    const provider = entry.id.split("/")[0]!;
    by.set(provider, [...(by.get(provider) ?? []), entry]);
  }
  return [...by];
}

/** Where the form keeps what was last filled in, in this browser: a reload or the next run starts from it. */
const SAVED = "swarm.launch";
/**
 * The fields the form keeps by name; the scenario and the model are kept from its state. Not the
 * goal: it can say what a private repo is about, and the next person on this browser would see it.
 */
const KEPT = ["repo", "agents", "budgetUsd", "minutes"] as const;

type Saved = Partial<Record<(typeof KEPT)[number] | "scenario" | "model", string>>;

/** What was saved, or nothing: storage can be blocked or hold something else. */
function load(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Saved) : {};
  } catch {
    return {};
  }
}

function save(form: HTMLFormElement, scenario: Scenario, model: string) {
  const data = new FormData(form);
  const saved: Saved = { scenario, model };
  for (const name of KEPT) saved[name] = String(data.get(name) ?? "");
  try {
    localStorage.setItem(SAVED, JSON.stringify(saved));
  } catch {
    // Storage is blocked: the form still works, it just starts over next time.
  }
}

/** The form that launches a run: a repo the GitHub app is on, a goal, a scenario, a model, how many agents, and when to stop. */
export function Launch({ repos, models, install }: { repos: string[]; models: Model[]; install: string | null }): ReactNode {
  const router = useRouter();
  const [pending, begin] = useTransition();
  const [scenario, setScenario] = useState<Scenario>(DEFAULTS.scenario);
  const [model, setModel] = useState(models.some((entry) => entry.id === DEFAULTS.model) ? DEFAULTS.model : (models[0]?.id ?? DEFAULTS.model));
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const price = useMemo(() => models.find((entry) => entry.id === model)?.price ?? null, [models, model]);
  const form = useRef<HTMLFormElement>(null);
  const [restored, setRestored] = useState(false);

  // What was filled in last time, once the page is in the browser: the server renders the defaults.
  // A saved repo or model that's no longer offered is left at the default.
  useEffect(() => {
    const saved = load();
    if (saved.scenario && SCENARIOS.includes(saved.scenario as Scenario)) setScenario(saved.scenario as Scenario);
    if (saved.model && (models.length === 0 || models.some((entry) => entry.id === saved.model))) setModel(saved.model);
    const fields = form.current?.elements;
    for (const name of KEPT) {
      const field = fields?.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      const value = saved[name];
      if (!field || value === undefined || (name === "repo" && !repos.includes(value))) continue;
      field.value = value;
    }
    setRestored(true);
  }, [models, repos]);

  // The scenario and the model are state, so they're saved once they change, after the restore.
  useEffect(() => {
    if (restored && form.current) save(form.current, scenario, model);
  }, [restored, scenario, model]);

  return (
    <form
      ref={form}
      className="launch"
      onChange={(event) => restored && save(event.currentTarget, scenario, model)}
      onSubmit={(event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        begin(async () => {
          const result = await start({ ...data, scenario, model });
          if (result.ok) {
            setSaid({ ok: true, text: `已发起 ${result.slug}。它会克隆仓库，并在一两分钟内启动第一个代理。` });
            router.refresh();
          } else setSaid({ ok: false, text: result.problem });
        });
      }}
    >
      <label className="row">
        <span>仓库</span>
        <select name="repo" required defaultValue={repos[0] ?? ""}>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </label>
      {install ? (
        <p className="note row-note">
          缺少仓库？<a href={install}>把它加到 GitHub 应用</a>。
        </p>
      ) : null}

      <fieldset className="row">
        <legend>场景</legend>
        <div className="choices">
          {SCENARIOS.map((id) => (
            <label key={id} className="choice" data-on={scenario === id ? "" : undefined}>
              <input type="radio" name="scenario-pick" value={id} checked={scenario === id} onChange={() => setScenario(id)} />
              <strong>{ABOUT_SCENARIO[id].label}</strong>
              <span>{ABOUT_SCENARIO[id].about}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="row">
        <span>目标</span>
        <textarea
          name="goal"
          required
          minLength={15}
          rows={4}
          placeholder={scenario === "pipeline" ? "给每个 API 路由加输入校验，并各配一个测试。" : "找出安全漏洞：注入、缺失的鉴权检查、日志里的密钥。"}
        />
      </label>

      <label className="row">
        <span>模型</span>
        {models.length ? (
          // Every model AI Gateway lists, by provider. A datalist would show only the ones matching what's filled in.
          <select name="model-pick" value={model} onChange={(event) => setModel(event.target.value)} required>
            {providers(models).map(([provider, entries]) => (
              <optgroup key={provider} label={provider}>
                {entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id.slice(provider.length + 1)} · {perMillion(entry.price)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <input name="model-pick" value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} autoComplete="off" required />
        )}
      </label>
      <p className="note row-note">{price ? perMillion(price) : models.length ? "该模型未列出价格：请给运行设一个时间上限。" : "任意 AI Gateway 模型 ID。"}</p>

      <div className="numbers">
        <label>
          <span>代理数</span>
          <input name="agents" type="number" min={1} max={MAX_AGENTS} defaultValue={DEFAULTS.agents} required />
        </label>
        <label>
          <span>预算（$）</span>
          <input name="budgetUsd" type="number" min={1} max={10_000} defaultValue={DEFAULTS.budgetUsd ?? ""} placeholder="不限" />
        </label>
        <label>
          <span>时长（分钟）</span>
          <input name="minutes" type="number" min={5} max={MAX_MINUTES} defaultValue={DEFAULTS.minutes ?? ""} placeholder={`最多 ${MAX_MINUTES}`} />
        </label>
      </div>

      <div className="submit">
        <button type="submit" className="button" disabled={pending || repos.length === 0}>
          {pending ? "发起中" : "发起"}
        </button>
        {said ? (
          <p className={said.ok ? "said" : "said bad"} role="status">
            {said.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
