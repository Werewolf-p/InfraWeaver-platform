"use client";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface SimpleModeContextType {
  simpleMode: boolean;
  setSimpleMode: (v: boolean) => void;
  toggle: () => void;
}

const SimpleModeContext = createContext<SimpleModeContextType>({
  simpleMode: false,
  setSimpleMode: () => {},
  toggle: () => {},
});

export function SimpleModeProvider({ children }: { children: ReactNode }) {
  const [simpleMode, setSimpleModeState] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("infraweaver-simple-mode");
    if (stored === "true") setSimpleModeState(true);
  }, []);

  const setSimpleMode = (v: boolean) => {
    setSimpleModeState(v);
    localStorage.setItem("infraweaver-simple-mode", String(v));
  };

  const toggle = () => setSimpleMode(!simpleMode);

  return (
    <SimpleModeContext.Provider value={{ simpleMode, setSimpleMode, toggle }}>
      {children}
    </SimpleModeContext.Provider>
  );
}

export const useSimpleMode = () => useContext(SimpleModeContext);
