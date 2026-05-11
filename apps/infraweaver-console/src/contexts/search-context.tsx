"use client";
import { createContext, useContext, useState, ReactNode } from "react";

interface SearchContextType {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
}

const SearchContext = createContext<SearchContextType>({
  searchOpen: false,
  setSearchOpen: () => {},
});

export function SearchProvider({ children }: { children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <SearchContext.Provider value={{ searchOpen, setSearchOpen }}>
      {children}
    </SearchContext.Provider>
  );
}

export const useSearch = () => useContext(SearchContext);
