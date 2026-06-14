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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with an external/browser store or dependency-driven reset; not derived render state
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
