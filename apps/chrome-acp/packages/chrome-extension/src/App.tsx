import { useCallback, useState } from "react";
import { ACPConnect } from "@/components/ACPConnect";
import { ACPMain } from "@chrome-acp/shared/components";
import { ThemeProvider } from "@chrome-acp/shared/lib";
import type { ACPClient } from "@chrome-acp/shared/acp";
import { buildActiveTabContext } from "@/lib/active-tab-context";
import "./index.css";

export function App() {
  const [client, setClient] = useState<ACPClient | null>(null);
  const [expanded, setExpanded] = useState(true);

  // Active tab context is collected on every send. The chrome-acp
  // session by itself does not know about the user's current tab, so
  // we inject url/title/excerpt before the agent sees the prompt.
  const prependContext = useCallback(async (): Promise<string | null> => {
    try {
      return await buildActiveTabContext();
    } catch (error) {
      console.warn("[App] buildActiveTabContext failed:", error);
      return null;
    }
  }, []);

  return (
    <ThemeProvider>
      <div className="flex flex-col h-dvh w-full">
        {/* Unified Connection Bar */}
        <ACPConnect
          onClientReady={setClient}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />

        {/* Main Content */}
        <main className="flex-1 overflow-hidden">
          {client ? (
            <ACPMain client={client} prependContext={prependContext} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <p className="text-lg mb-2">No agent connected</p>
                <p className="text-sm">Click the status bar above to configure connection</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </ThemeProvider>
  );
}

export default App;
