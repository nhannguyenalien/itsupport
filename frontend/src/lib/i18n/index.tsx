"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import vi from "./vi.json";
import en from "./en.json";
import fr from "./fr.json";
import ko from "./ko.json";
import ja from "./ja.json";
import es from "./es.json";

export const languages = {
  vi: { name: "Tiếng Việt", locale: "vi-VN" },
  en: { name: "English", locale: "en-US" },
  fr: { name: "Français", locale: "fr-FR" },
  ko: { name: "한국어", locale: "ko-KR" },
  ja: { name: "日本語", locale: "ja-JP" },
  es: { name: "Español", locale: "es-ES" },
} as const;
export type Language = keyof typeof languages;
export type MessageKey = keyof typeof vi;
const messages: Record<Language, Record<MessageKey, string>> = { vi, en, fr, ko, ja, es };
export const LANGUAGE_STORAGE_KEY = "itsupport.language";
const isLanguage = (value: string | null): value is Language => value !== null && Object.hasOwn(languages, value);
type Variables = Record<string, string | number>;
type LanguageContextValue = {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  // Unknown server errors are preserved; only authored interface messages are translated.
  tx: (key: string, variables?: Variables) => string;
};
const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>("vi");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (isLanguage(saved)) updateLanguage(saved);
    } catch { /* The selector also works when storage is unavailable. */ }
    const synchronize = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && isLanguage(event.newValue)) updateLanguage(event.newValue);
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const setLanguage = useCallback((next: Language) => {
    updateLanguage(next);
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Session-only preference. */ }
  }, []);
  const tx = useCallback((key: string, variables?: Variables) => {
    const text = Object.hasOwn(messages[language], key) ? messages[language][key as MessageKey] : key;
    return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => variables?.[name] === undefined ? placeholder : String(variables[name]));
  }, [language]);
  return <LanguageContext.Provider value={{ language, locale: languages[language].locale, setLanguage, tx }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used within LanguageProvider");
  return value;
}

export function LanguageSwitcher() {
  const { language, setLanguage, tx } = useLanguage();
  return <label className="locale-selector"><span aria-hidden="true">◎</span><select aria-label={tx("language")} value={language} onChange={(event) => { if (isLanguage(event.target.value)) setLanguage(event.target.value); }}>
    {(Object.keys(languages) as Language[]).map((code) => <option key={code} value={code} lang={code}>{languages[code].name}</option>)}
  </select></label>;
}
