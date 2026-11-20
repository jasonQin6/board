import type { ReactNode } from "react";
import type { Launcher } from "@/lib/launcher";
import { headline, progress } from "@/lib/setup";
import { Copy } from "./copy";
import { Launch } from "./launch";
import { Live } from "./live";
import { Runs } from "./runs";
import { Stepper, Tasks } from "./stepper";

/** The launcher's page, from one check of the deployment: how to protect it, its setup, or once it's set up, the form and the runs. */
export function LauncherView({ result, inspect, models, runs, swarm, origin }: Launcher & { swarm: string; origin: string }): ReactNode {
  const { title, lede } = headline(result);

  // Anyone can open this page: it says how to close it, and nothing about the swarm.
  if (result.open) {
    return (
      <main className="launcher">
        <section className="hero">
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </section>
        <section className="panel">
          <Tasks tasks={[result.task]} />
        </section>
        <Live polling />
      </main>
    );
  }

  const { steps, found } = result;
  const { done, of, ready } = progress(steps);
  const active = runs.some((run) => run.phase === "running" || run.phase === "preparing");
  const join = `阅读 ${origin}/join.md 并照着做，从我们团队板面的 ${swarm} 队列领取任务。`;
  const watch = (
    <section className="panel">
      <h2>观看运行</h2>
      <p className="note">{swarm} 下的每个任务、代理和消息，实时呈现。</p>
      <p>
        <a className="button" href="/live">
          打开实时视图
        </a>
      </p>
      <p className="note">
        或在终端看整个板面：<code className="inline">{inspect}</code>。想让本机的编码代理帮忙？<Copy text={join} label="复制这段提示词" quiet />
      </p>
    </section>
  );

  if (ready) {
    return (
      <main className="launcher">
        <section className="hero">
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </section>
        <section className="panel">
          <Launch repos={found.repos} models={models} install={found.install} />
        </section>
        <section className="panel">
          <h2>运行</h2>
          <Runs runs={runs} swarm={swarm} now={Date.now()} />
        </section>
        {watch}
        <details className="panel setup">
          <summary>
            设置
            <span>
              已完成 {done}/{of}
            </span>
          </summary>
          <Stepper steps={steps} />
        </details>
        {/* A run moves on its own: the page follows while one is going. */}
        <Live polling={active} />
      </main>
    );
  }

  return (
    <main className="launcher">
      <section className="hero">
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
        <div className="hero-links">
          <span className="progress">
            已完成 {done}/{of}
          </span>
        </div>
      </section>
      <Stepper steps={steps} />
      {/* While a step is left, it can get done at any moment, somewhere else. */}
      <Live polling />
      {watch}
    </main>
  );
}
