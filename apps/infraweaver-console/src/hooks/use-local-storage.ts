"use client";

import { Dispatch, SetStateAction, useEffect, useState } from "react";

function resolveDefaultValue<T>(value: T | (() => T)) {
  return typeof value === "function" ? (value as () => T)() : value;
}

export function useLocalStorage<T>(
  key: string,
  defaultValue: T | (() => T),
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    const fallbackValue = resolveDefaultValue(defaultValue);
    if (typeof window === "undefined") return fallbackValue;

    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : fallbackValue;
    } catch {
      return fallbackValue;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      // Ignore storage write failures.
    }
  }, [key, storedValue]);

  return [storedValue, setStoredValue] as const;
}
