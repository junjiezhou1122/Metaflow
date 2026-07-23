import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, GitFork, Sparkles, Waypoints } from "lucide-react";
import metaflowMarkUrl from "./assets/metaflow-mark.png";
import "./styles.css";

const GITHUB_URL = "https://github.com/junjiezhou1122/Metaflow";

function Website() {
  return (
    <main className="metaflow-site">
      <header className="site-nav">
        <a className="wordmark" href="#top" aria-label="MetaFlow home">
          <img src={metaflowMarkUrl} alt="" />
          <span>MetaFlow</span>
        </a>
        <nav aria-label="MetaFlow sections">
          <a href="#system">System</a>
          <a href="#runtime">Runtime</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
      </header>

      <section id="top" className="hero">
        <MetaFlowField />
        <div className="hero-rail rail-left" aria-hidden="true">
          <span>FLOW FIELD</span>
          <b>CTX 0.86</b>
          <b>AGENTS LIVE</b>
          <b>VIEWGRAPH HOT</b>
        </div>
        <div className="hero-rail rail-right" aria-hidden="true">
          <span>RUNTIME</span>
          <b>OBSERVE</b>
          <b>COMPRESS</b>
          <b>ACT</b>
        </div>
        <div className="hero-copy">
          <p>Personal context that moves with your work.</p>
          <h1>Own your flow.</h1>
          <span>
            MetaFlow turns your screens, sessions, memories, and agent work into a living local intelligence layer.
          </span>
          <div className="hero-actions">
            <a className="primary-action" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GitFork size={19} strokeWidth={2.3} />
              <span>View on GitHub</span>
              <ArrowRight size={18} strokeWidth={2.4} />
            </a>
            <a className="secondary-action" href="#system">
              <Waypoints size={18} strokeWidth={2.2} />
              <span>See the system</span>
            </a>
          </div>
        </div>
        <a className="scroll-cue" href="#system">SCROLL</a>
      </section>

      <section id="system" className="mission">
        <div className="mission-copy">
          <div className="kicker">SYSTEM</div>
          <h2>Observe your work. Route the task. Compile the right view.</h2>
          <p>
            MetaFlow is a local-first context runtime for agentic work. It watches the sources you already use,
            understands what kind of task is emerging, then turns raw evidence into durable views agents can inspect and act on.
          </p>
        </div>
        <div className="flow-diagram" aria-label="MetaFlow observe route view pipeline">
          <FlowStep index="01" title="Observe" body="screen, browser, repo, audio, memory, active thread" />
          <FlowStep index="02" title="Route" body="research, writing, planning, toolsmith, language review" />
          <FlowStep index="03" title="Compile Views" body="evidence, intent, workflow, advice, task, draft, memory" />
          <FlowStep index="04" title="Act" body="ambient suggestions, background tasks, artifacts, agent handoff" />
        </div>
        <div className="source-grid" aria-label="Sources and views">
          <InfoColumn title="Sources" items={["Screenpipe", "Browser", "Git + project", "Runtime events"]} />
          <InfoColumn title="Task shape" items={["Need research", "Continue writing", "Build a tool", "Review language"]} />
          <InfoColumn title="Views" items={["brief.research", "advice.writing", "task.toolsmith", "memory.profile"]} />
        </div>
      </section>

      <section id="runtime" className="runtime" aria-label="MetaFlow runtime stack">
        <div className="stack-visual" aria-hidden="true">
          <div className="stack-layer layer-one"><span>Evidence</span></div>
          <div className="stack-layer layer-two"><span>Views</span></div>
          <div className="stack-layer layer-three"><span>Programs</span></div>
          <div className="stack-layer layer-four"><span>Agents</span></div>
        </div>
        <div className="runtime-copy">
          <div className="kicker">RUNTIME</div>
          <h2>Context becomes a surface agents can actually use.</h2>
          <p>
            Every signal is shaped into inspectable views before it becomes advice, a task, a draft, or a tool artifact.
            That keeps MetaFlow fast, local, and accountable.
          </p>
          <div className="runtime-actions">
            <a className="primary-action" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GitFork size={19} strokeWidth={2.3} />
              <span>Open Metaflow repo</span>
              <ArrowRight size={18} strokeWidth={2.4} />
            </a>
            <a className="secondary-action" href="#top">
              <Sparkles size={18} strokeWidth={2.2} />
              <span>Back to top</span>
            </a>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div>
          <img src={metaflowMarkUrl} alt="" />
          <span>MetaFlow</span>
        </div>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          <GitFork size={16} strokeWidth={2.3} />
          github.com/junjiezhou1122/Metaflow
        </a>
      </footer>
    </main>
  );
}

function FlowStep({ index, title, body }: { index: string; title: string; body: string }) {
  return (
    <div className="flow-step">
      <span>{index}</span>
      <b>{title}</b>
      <p>{body}</p>
    </div>
  );
}

function InfoColumn({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <span>{title}</span>
      {items.map(item => <b key={item}>{item}</b>)}
    </div>
  );
}

function MetaFlowField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const maybeSurface = canvasRef.current;
    if (!maybeSurface) return;
    const surface: HTMLCanvasElement = maybeSurface;
    const maybeContext = surface.getContext("2d");
    if (!maybeContext) return;
    const ctx: CanvasRenderingContext2D = maybeContext;

    let frame = 0;
    let animation = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    function resize() {
      const rect = surface.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      surface.width = Math.floor(width * dpr);
      surface.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      frame += 0.0075;
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#071d36");
      gradient.addColorStop(0.46, "#0c3140");
      gradient.addColorStop(1, "#062522");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      for (let band = 0; band < 18; band += 1) {
        const yBase = height * (0.17 + band * 0.042);
        const hue = band % 3 === 0 ? "151, 229, 206" : band % 3 === 1 ? "98, 178, 255" : "239, 232, 203";
        ctx.beginPath();
        for (let x = -40; x <= width + 40; x += 18) {
          const drift = Math.sin(x * 0.008 + frame * (1.8 + band * 0.02) + band * 0.67) * (24 + band * 0.9);
          const pulse = Math.cos(x * 0.014 - frame * 1.3 + band) * 8;
          const y = yBase + drift + pulse + Math.sin(frame + band) * 20;
          if (x === -40) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${hue}, ${0.08 + band * 0.006})`;
        ctx.lineWidth = band % 4 === 0 ? 1.6 : 0.8;
        ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.88;
      for (let i = 0; i < 90; i += 1) {
        const phase = frame * (0.5 + (i % 7) * 0.05) + i * 2.17;
        const x = (width * (0.08 + ((i * 37) % 100) / 118) + Math.sin(phase) * 46) % width;
        const y = height * (0.16 + ((i * 23) % 100) / 134) + Math.cos(phase * 0.9) * 34;
        const radius = i % 9 === 0 ? 2.2 : 1.15;
        ctx.fillStyle = i % 5 === 0 ? "rgba(181, 255, 221, 0.72)" : "rgba(222, 245, 235, 0.42)";
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      const shade = ctx.createRadialGradient(width * 0.5, height * 0.5, height * 0.08, width * 0.5, height * 0.55, height * 0.78);
      shade.addColorStop(0, "rgba(255,255,255,0)");
      shade.addColorStop(1, "rgba(0,0,0,0.48)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();

      animation = window.requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(animation);
    };
  }, []);

  return <canvas ref={canvasRef} className="flow-field" aria-hidden="true" />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Website />
  </React.StrictMode>
);
