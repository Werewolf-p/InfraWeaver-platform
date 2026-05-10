"use client";
import { useEffect, useRef } from "react";
import confetti from "canvas-confetti";

interface ConfettiOptions {
  duration?: number;
  colors?: string[];
}

export function launchConfetti(options: ConfettiOptions = {}) {
  const { colors = ["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#ec4899"] } = options;

  const end = Date.now() + (options.duration ?? 3000);

  const frame = () => {
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      origin: { x: 0 },
      colors,
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      origin: { x: 1 },
      colors,
    });
    if (Date.now() < end) {
      requestAnimationFrame(frame);
    }
  };
  frame();
}

interface ConfettiProps {
  active: boolean;
  duration?: number;
  colors?: string[];
}

export function Confetti({ active, duration = 3000, colors }: ConfettiProps) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (active && !firedRef.current) {
      firedRef.current = true;
      launchConfetti({ duration, colors });
    }
    if (!active) {
      firedRef.current = false;
    }
  }, [active, duration, colors]);

  return null;
}
