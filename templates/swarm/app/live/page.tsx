import { headers } from "next/headers";
import { Swarm } from "./swarm";
import { SWARM, NAME } from "@/lib/board";
import { OPEN, open } from "@/lib/gate";
import { sharedSnapshot } from "@/lib/swarm";
import "./live.css";

// Every load reads the board: the queue is the swarm's, not this build's.
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The page shows whatever the swarm writes: only to the team.
  if (await open((await headers()).get("host"))) {
    return (
      <div className="live">
        <main className="lost">
          <h1>{NAME}</h1>
          <p>{OPEN}</p>
        </main>
      </div>
    );
  }
  const query = await searchParams;
  // A rate-limited read is tried once more: it's usually the board catching its breath.
  const first = await sharedSnapshot()
    .catch(() => new Promise((resolve) => setTimeout(resolve, 2_000)).then(() => sharedSnapshot()))
    .catch((error: unknown) => (error as Error).message);
  if (typeof first === "string") {
    return (
      <div className="live">
        <main className="lost">
          <h1>{NAME} Board</h1>
          <p>
            无法读取 <code>{SWARM}</code>：{first}
          </p>
          <p className="faint">
            在本机，运行 <code>npx @vercel/board serve</code>，用它打印的 <code>BOARD_URL</code> 启动本应用。在 Vercel 上，启动器的设置会说明缺了什么。
          </p>
        </main>
      </div>
    );
  }
  return (
    <div className="live">
      <Swarm first={first} channel={one(query.ch)} task={one(query.task)} />
    </div>
  );
}
