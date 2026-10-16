"use client";

// Adapted from React Bits "CountUp" (https://reactbits.dev, MIT + Commons Clause, see REACT-BITS-LICENSE.md):
// rewritten without `motion`, bigint-safe for money, and no replay on hydration.

import { useEffect, useRef, useState } from "react";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { easeOutCubic, tweenCount, tweenMinor } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { reducedMotion, useArrival } from "./arrival";

type Props = {
  /** Money in minor units (with `currency`) or a plain count. */
  value: bigint | number;
  /** Formats `value` as compact money in this currency; without it `value` is a count. */
  currency?: string;
  suffix?: string;
  durationMs?: number;
  className?: string;
};

/**
 * A number that counts up to its value when the view arrives by navigation. Server HTML and reduced motion show the value
 * at once; the last frame is always exactly `value`, and a later change of `value` shows the new value without replaying.
 */
export function CountUp({ value, currency, suffix = "", durationMs = 700, className }: Props) {
  const arrive = useArrival();
  const [frame, setFrame] = useState<bigint | number | null>(() => (arrive ? zeroOf(value) : null));
  const ref = useRef<HTMLSpanElement>(null);
  const target = useRef(value);
  useEffect(() => {
    target.current = value;
  });

  useEffect(() => {
    if (!arrive) return;
    const el = ref.current;
    // Off screen at arrival: nobody sees it count, so show the value.
    const offScreen = !el || el.getBoundingClientRect().top > window.innerHeight;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = offScreen ? 1 : easeOutCubic((now - start) / durationMs);
      const to = target.current;
      if (t >= 1) return setFrame(null);
      setFrame(typeof to === "bigint" ? tweenMinor(0n, to, t) : tweenCount(0, to, t));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [arrive, durationMs]);

  const shown = frame ?? value;
  const text = typeof shown === "bigint" ? (currency ? formatMoneyCompact(shown, currency) : shown.toLocaleString("id-ID")) : shown.toLocaleString("id-ID");
  return <span ref={ref} className={cn("num", className)}>{text}{suffix}</span>;
}

function zeroOf(v: bigint | number): bigint | number {
  return typeof v === "bigint" ? 0n : 0;
}

/**
 * The same count for a long page (the public site): it counts the first time it scrolls into view, so a reader sees the books
 * add up instead of a number that was already final off screen. On screen at mount, under reduced motion or without
 * JavaScript, it is the final value from the first paint. Money is shown in full (`Rp 12.552.852.217`), every frame a real amount.
 */
export function CountUpOnView({ value, currency, durationMs = 900, className }: { value: bigint | number; currency?: string; durationMs?: number; className?: string }) {
  const [frame, setFrame] = useState<bigint | number | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof IntersectionObserver === "undefined") return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    // Below the fold: the reader has not seen the value yet, so starting it from zero is never a visible jump.
    setFrame(zeroOf(value));
    let raf = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      const start = performance.now();
      const tick = (now: number) => {
        const t = easeOutCubic((now - start) / durationMs);
        if (t >= 1) return setFrame(null);
        setFrame(typeof value === "bigint" ? tweenMinor(0n, value, t) : tweenCount(0, value, t));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, { threshold: 0.6 });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, durationMs]);

  const shown = frame ?? value;
  const text = typeof shown === "bigint" && currency ? formatMoney(shown, currency) : shown.toLocaleString("id-ID");
  return <span ref={ref} className={cn("num", className)}>{text}</span>;
}

