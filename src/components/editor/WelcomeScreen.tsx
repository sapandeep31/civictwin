"use client";

/**
 * Praesidium landing page: full-bleed night hero with a live low-poly 3D
 * vignette, followed by problem / how / compare / impact / tech sections.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import Lenis from "lenis";
import { Play, Plus, MapPin, FolderOpen, Clock, ArrowRight, Upload, MapPinned, MoonStar, IndianRupee } from "lucide-react";

import { useEditor } from "@/lib/store/editor";
import { listSavedProjects, loadProject } from "@/lib/storage/projects";
import { parseProject } from "@/lib/world/serialize";
import type { PraesidiumProject } from "@/lib/world/types";
import { HERO_BLUR } from "@/components/landing/heroBlur";
import ImportDialog from "./ImportDialog";
import { Problem, HowItWorks, SameNight, SocialImpact, BuiltWith, Reveal } from "./landing/Sections";

/** Pre-rendered hero art, art-directed per device (see public/hero). */
function HeroArt() {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth) setLoaded(true);
  }, []);
  const blurVars = {
    "--b-phone": `url("${HERO_BLUR.phone}")`,
    "--b-tablet": `url("${HERO_BLUR.tablet}")`,
    "--b-desktop": `url("${HERO_BLUR.desktop}")`,
  } as React.CSSProperties;
  return (
    <div aria-hidden className="hero-blur absolute inset-0 -z-10 overflow-hidden" style={blurVars}>
      <picture className="hero-drift absolute inset-0 block">
        <source media="(min-width: 1024px)" srcSet="/hero/desktop.avif" type="image/avif" />
        <source media="(min-width: 1024px)" srcSet="/hero/desktop.webp" type="image/webp" />
        <source media="(min-width: 640px)" srcSet="/hero/tablet.avif" type="image/avif" />
        <source media="(min-width: 640px)" srcSet="/hero/tablet.webp" type="image/webp" />
        <source srcSet="/hero/phone.avif" type="image/avif" />
        <source srcSet="/hero/phone.webp" type="image/webp" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src="/hero/phone.webp"
          alt=""
          decoding="async"
          fetchPriority="high"
          onLoad={() => setLoaded(true)}
          className={`hero-img h-full w-full object-cover ${loaded ? "is-loaded" : ""}`}
        />
      </picture>
    </div>
  );
}

function Shield({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 2 L20 6 V12 C20 17 16.5 20.5 12 22 C7.5 20.5 4 17 4 12 V6 Z" />
    </svg>
  );
}

export default function WelcomeScreen() {
  const openDemo = useEditor((s) => s.openDemo);
  const newBlank = useEditor((s) => s.newBlank);
  const openProject = useEditor((s) => s.openProject);
  const setImportOpen = useEditor((s) => s.setImportOpen);

  const [recent, setRecent] = useState<{ projectId: string; name: string; modifiedAt: string }[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listSavedProjects()
      .then((r) => setRecent(r.slice(0, 6).map((x) => ({ projectId: x.projectId, name: x.name, modifiedAt: x.modifiedAt }))))
      .catch(() => setRecent([]));
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // inertial smooth scroll, landing only; anchors offset for the fixed nav
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let lenis: Lenis | null = null;
    let raf = 0;
    if (!reduced) {
      lenis = new Lenis({ duration: 1.1, easing: (x) => 1 - Math.pow(1 - x, 4) });
      const loop = (time: number) => {
        lenis?.raf(time);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    const onAnchor = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!a) return;
      const id = a.getAttribute("href")!.slice(1);
      const el = id === "top" ? null : document.getElementById(id);
      if (id !== "top" && !el) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(el ?? 0, { offset: 0 }); // sections are full-viewport and pad for the nav
      else window.scrollTo({ top: el ? el.getBoundingClientRect().top + window.scrollY - 64 : 0, behavior: reduced ? "auto" : "smooth" });
    };
    document.addEventListener("click", onAnchor);
    return () => {
      document.removeEventListener("click", onAnchor);
      cancelAnimationFrame(raf);
      lenis?.destroy();
    };
  }, []);

  const openFromFile = useCallback(
    async (file: File) => {
      setFileError(null);
      try {
        const parsed = parseProject(JSON.parse(await file.text()));
        if (!parsed.ok || !parsed.project) {
          setFileError(parsed.error ?? "The file could not be parsed as a Praesidium project.");
          return;
        }
        openProject(parsed.project as PraesidiumProject);
      } catch {
        setFileError("Invalid project file format (valid JSON required).");
      }
    },
    [openProject]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "d") {
        e.preventDefault();
        openDemo();
      } else if (k === "b") {
        e.preventDefault();
        newBlank();
      } else if (k === "i") {
        e.preventDefault();
        setImportOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDemo, newBlank, setImportOpen]);

  const handleOpenProject = async (id: string) => {
    const proj = await loadProject(id);
    if (proj) openProject(proj);
  };

  const primaryBtn =
    "group inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-[#060b18] transition hover:bg-teal-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300";
  const secondaryBtn =
    "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-medium text-slate-300 ring-1 ring-white/15 transition hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

  const bullets = [
    { icon: MapPinned, t: "Pick your society on a satellite map" },
    { icon: MoonStar, t: "Watch a full night play out: muggings, blind spots, sleeping guards" },
    { icon: IndianRupee, t: "Know which rupee actually makes residents safer" },
  ];

  return (
    <div className="relative min-h-screen bg-[#060b18] text-slate-200 antialiased selection:bg-teal-400/30" style={{ fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui" }}>
      <header
        className={`hero-nav fixed inset-x-0 top-0 z-40 border-b transition-[background-color,border-color,backdrop-filter] duration-300 ${
          scrolled ? "border-white/[0.08] bg-[#060b18]/70 backdrop-blur-xl" : "border-transparent bg-transparent"
        }`}
      >
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-5 sm:px-8">
          <a href="#top" className="flex items-center gap-2 text-white">
            <Shield className="h-[18px] w-[18px] text-white" />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Praesidium</span>
          </a>
          <nav className="flex items-center gap-6">
            <a href="#how" className="hidden rounded text-sm text-slate-400 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-teal-300/60 sm:block">How it works</a>
            <a href="#impact" className="hidden rounded text-sm text-slate-400 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-teal-300/60 sm:block">Impact</a>
            <button onClick={openDemo} className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-[#060b18] transition hover:bg-slate-200">
              Launch demo
            </button>
          </nav>
        </div>
      </header>

      <main id="top">
        {/* Hero */}
        <section className="relative isolate min-h-[100svh] overflow-hidden pb-[520px] lg:h-[100svh] lg:min-h-[640px] lg:pb-0">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{ background: "linear-gradient(180deg, #0a1430 0%, #0b1531 60%, #070d1f 100%)" }}
          />
          <HeroArt />
          {/* legibility: dark left-to-right on desktop, top-to-bottom on phone/tablet */}
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 hidden lg:block" style={{ background: "linear-gradient(90deg, rgba(6,11,24,0.9) 0%, rgba(6,11,24,0.72) 32%, rgba(6,11,24,0.22) 50%, transparent 62%)" }} />
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 lg:hidden" style={{ background: "linear-gradient(180deg, rgba(6,11,24,0.92) 0%, rgba(6,11,24,0.78) 42%, rgba(6,11,24,0.3) 56%, transparent 64%)" }} />
          <div className="mx-auto flex h-full w-full max-w-[1200px] px-5 pt-24 sm:px-8 lg:items-center lg:pt-8">
            <div className="max-w-xl">
              <h1 className="hero-h1 text-balance text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.045em] text-white sm:text-6xl lg:text-[4.25rem]">
                Safer nights.
                <br />
                <span className="text-slate-400">Smarter spending.</span>
              </h1>
              <p style={{ "--d": "0.08s" } as React.CSSProperties} className="hero-fade mt-6 max-w-md text-pretty text-lg leading-relaxed text-slate-300">
                Simulate your society&rsquo;s night before you spend a rupee on guards, cameras or lights.
              </p>
              <ul className="mt-8 space-y-3.5">
                {bullets.map((b, i) => (
                  <li key={b.t} style={{ "--d": `${0.16 + i * 0.06}s` } as React.CSSProperties} className="hero-fade flex items-start gap-3 text-[15px] text-slate-300">
                    <b.icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-teal-300" strokeWidth={1.75} />
                    {b.t}
                  </li>
                ))}
              </ul>
              <div style={{ "--d": "0.36s" } as React.CSSProperties} className="hero-fade mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
                <button onClick={openDemo} className={primaryBtn}>
                  <Play strokeWidth={2} className="h-4 w-4 fill-current" />
                  Launch live demo
                </button>
                <button onClick={() => setImportOpen(true)} className={secondaryBtn}>
                  Build my society
                  <ArrowRight strokeWidth={1.75} className="h-4 w-4" />
                </button>
              </div>
              {recent[0] ? (
                <button
                  onClick={() => handleOpenProject(recent[0].projectId)}
                  style={{ "--d": "0.4s" } as React.CSSProperties}
                  className="hero-fade group mt-4 inline-flex max-w-md items-center gap-2 rounded-full bg-white/[0.06] px-4 py-2 text-left text-sm text-slate-200 ring-1 ring-white/10 transition hover:bg-white/10 hover:ring-teal-300/40"
                >
                  <Clock strokeWidth={1.75} className="h-4 w-4 shrink-0 text-teal-300" />
                  <span className="truncate">
                    Continue where you left off: <span className="font-semibold text-white">{recent[0].name}</span>
                  </span>
                  <ArrowRight strokeWidth={1.75} className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-teal-300" />
                </button>
              ) : (
                <p style={{ "--d": "0.4s" } as React.CSSProperties} className="hero-fade mt-3 max-w-md text-pretty text-xs italic leading-relaxed text-slate-400/80">
                  * We suggest starting with the demo society (Launch live demo) &mdash; it&rsquo;s pre-loaded and runs instantly.
                </p>
              )}
            </div>
          </div>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[#060b18]" />
        </section>

        <Problem />
        <HowItWorks />
        <SameNight />
        <SocialImpact />
        <BuiltWith />

        {/* Final CTA / recent */}
        <section className="border-t border-white/[0.06] py-24 sm:py-32 scroll-mt-16">
          <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
            <Reveal className="rounded-3xl border border-white/10 bg-[#0a1324] p-8 text-center sm:p-14">
              <h2 className="text-balance text-3xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">See your society at night.</h2>
              <p className="mx-auto mt-4 max-w-md text-slate-400">Takes two minutes. Nothing to install.</p>
              <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                <button onClick={openDemo} className={primaryBtn}>
                  <Play strokeWidth={2} className="h-4 w-4 fill-current" />
                  Launch live demo
                </button>
                <button onClick={() => setImportOpen(true)} className={secondaryBtn}>
                  <MapPin strokeWidth={1.75} className="h-4 w-4" />
                  Build my society
                </button>
                <button onClick={newBlank} className={secondaryBtn}>
                  <Plus strokeWidth={1.75} className="h-4 w-4" />
                  Blank canvas
                </button>
              </div>
              <p className="mx-auto mt-4 max-w-md text-pretty text-xs italic leading-relaxed text-slate-400/80">
                * We suggest starting with the demo society (Launch live demo) &mdash; it&rsquo;s pre-loaded and runs instantly.
              </p>
              <div className="mt-5 text-sm text-slate-400">
                <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 underline-offset-4 transition hover:text-white hover:underline">
                  <Upload strokeWidth={1.5} className="h-3.5 w-3.5" />
                  Open a project file
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) openFromFile(f);
                    e.target.value = "";
                  }}
                />
              </div>
              {fileError && <p role="alert" className="mt-3 text-sm text-red-400">{fileError}</p>}

              {recent.length > 0 && (
                <div className="mt-10 border-t border-white/10 pt-8 text-left">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    <FolderOpen strokeWidth={1.5} className="h-4 w-4 text-teal-300" />
                    Saved on this device
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {recent.map((p) => (
                      <button
                        key={p.projectId}
                        onClick={() => handleOpenProject(p.projectId)}
                        className="group flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition hover:border-teal-300/50"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-white">{p.name}</div>
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                            <Clock strokeWidth={1.5} className="h-3 w-3" />
                            {new Date(p.modifiedAt).toLocaleDateString()}
                          </div>
                        </div>
                        <ArrowRight strokeWidth={1.5} className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-teal-300" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] py-8 text-xs text-slate-500">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-2 px-5 sm:flex-row sm:px-8">
          <span className="flex items-center gap-2">
            <Shield className="h-3.5 w-3.5 text-slate-400" />
            <span className="font-medium text-slate-300">Praesidium</span> · Google Cloud AI Builder Cup 2026
          </span>
          <span>Synthetic agents only. No profiling of real people.</span>
        </div>
      </footer>

      <ImportDialog />
    </div>
  );
}
