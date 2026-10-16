"use client";

// Adapted from React Bits "AnimatedContent" and "AnimatedList" (https://reactbits.dev, MIT + Commons Clause, see
// REACT-BITS-LICENSE.md): rewritten without gsap/motion as an IntersectionObserver plus CSS (`[data-reveal]` in app/globals.css).

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { reducedMotion } from "./arrival";

type State = "static" | "hidden" | "shown";

/**
 * Content that settles into place the first time it scrolls into view, once. Children marked `data-stagger` follow one after
 * another (AnimatedList). Server HTML, no-JavaScript readers, reduced motion and anything already on screen at mount stay
 * exactly as painted; only content the reader has not seen yet is hidden, so nothing visible ever flashes.
 */
export function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>("static");

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof IntersectionObserver === "undefined") return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
    // An effect runs after paint, but this element is below the fold, so hiding it now is never seen.
    setState("hidden");
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setState("shown");
      observer.disconnect();
    }, { rootMargin: "0px 0px -12% 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} data-reveal={state} className={cn("min-w-0", className)}>{children}</div>;
}
