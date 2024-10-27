import React, { useState, useEffect, useCallback, useRef } from "react";

const SYSTEM_PROMPT = `You are a code assistant. Follow these guidelines when responding:
1. Always return only the updated code, and avoid providing any explanations or extra text unless explicitly asked.
2. Use the syntax "module.exports = ComponentName;" at the end of the code. Do not use "export default".
3. Ensure the code is properly formatted and can be used directly in a Node.js/React environment.
4. Do not wrap the code in triple backticks unless explicitly requested by the user.
5. Respond with concise, minimal updates based on the user prompt.
6. If the user requests code modifications, return the full code with changes applied, formatted correctly for use.`;

const examples = {
  simple: `function SimpleComponent() {
  return (
    <div className="p-4 bg-green-100 rounded">
      <h3 className="text-lg font-bold">Hello World</h3>
      <p>This is a simple component.</p>
    </div>
  );
}

module.exports = SimpleComponent;
`,
  complex: `function ComplexComponent() {
  const [count, setCount] = React.useState(0);
  const buttonClassName = "mt-2 p-2 text-white rounded";

  return (
    <div className="p-4 bg-blue-100 rounded">
      <h3 className="text-lg font-semibold">Counter Component</h3>
      <p>Current Count: {count}</p>
      <button onClick={() => setCount(count + 1)} className={\`\${buttonClassName} bg-blue-500 hover:bg-blue-600\`}>
        Increment
      </button>
      <button onClick={() => setCount(0)} className={\`\${buttonClassName} ml-2 bg-red-500 hover:bg-red-600\`}>
        Reset
      </button>
    </div>
  );
}

module.exports = ComplexComponent;
`,
};

const MAX_RETRIES = 5;
const BABEL_CDN_URL =
  process.env.BABEL_CDN_URL || "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.1/babel.min.js";

const MainComponent = React.memo(
  ({ code: initialCode, previewProps = {}, noInlineStyles = false }) => {
    const [state, setState] = useState({
      error: null,
      loadingStatus: "idle",
      preview: null,
      code: initialCode,
      streamingResponse: "",
      aiPrompt: "",
      isUpdating: false,
      retryCount: 0,
      customPrompts: (() => {
        try {
          return JSON.parse(localStorage.getItem("customPrompts")) || [];
        } catch {
          return [];
        }
      })(),
      history: [],
    });

    const refs = {
      babel: useRef(null),
      babelLoaded: useRef(false),
    };

    const updateState = useCallback((updates) => {
      setState((prev) => ({ ...prev, ...updates }));
    }, []);

    const loadBabel = useCallback(() => {
      if (refs.babelLoaded.current && refs.babel.current)
        return Promise.resolve();
      updateState({ loadingStatus: "loading" });

      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = BABEL_CDN_URL;
        script.async = true;
        script.onload = () => {
          refs.babel.current = window.Babel;
          refs.babelLoaded.current = true;
          updateState({ loadingStatus: "idle" });
          resolve();
        };
        script.onerror = () => {
          updateState({
            error: "Failed to load Babel",
            loadingStatus: "error",
          });
          reject(new Error("Failed to load Babel"));
        };
        document.head.appendChild(script);
      });
    }, []);

    const transpileCode = useCallback(
      async (currentCode) => {
        try {
          await loadBabel();
          const transformedCode = noInlineStyles
            ? currentCode.replace(/style=\{\{.*?\}\}/g, "")
            : currentCode;
          return refs.babel.current.transform(transformedCode, {
            presets: ["react"],
            filename: "preview.jsx",
            sourceType: "module",
          }).code;
        } catch (err) {
          updateState({
            error: `Error during transpilation: ${err.message}`,
            loadingStatus: "error",
          });
          return null;
        }
      },
      [noInlineStyles, loadBabel]
    );

    const renderComponent = useCallback(async () => {
      const transpiledCode = await transpileCode(state.code);
      if (!transpiledCode) return;

      try {
        const module = { exports: {} };
        new Function("React", "useState", "exports", "module", transpiledCode)(
          React,
          useState,
          module.exports,
          module
        );
        const Component = module.exports;
        updateState({
          preview: React.createElement(Component, previewProps),
          loadingStatus: "ready",
        });
      } catch (err) {
        updateState({
          error: `Runtime error: ${err.message}`,
          loadingStatus: "error",
        });
      }
    }, [state.code, previewProps, transpileCode]);

    const updateWithAI = useCallback(async () => {
      if (!state.aiPrompt.trim()) {
        updateState({ error: "Please enter a prompt for the AI" });
        return;
      }

      updateState({ isUpdating: true, error: null });

      try {
        const response = await fetch(
          "/integrations/anthropic-claude-sonnet-3-5/",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                {
                  role: "user",
                  content: `Modify this React code: "${state.aiPrompt}". Code:\n\n${state.code}`,
                },
              ],
              stream: true,
            }),
          }
        );

        if (!response.ok)
          throw new Error(`AI API responded with status ${response.status}`);

        // Accumulate streamed response
        const reader = response.body.getReader();
        let aiResponse = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          aiResponse += new TextDecoder().decode(value);
        }

        // Check if the response is HTML by looking for a leading "<"
        if (aiResponse.trim().startsWith("<")) {
          throw new Error(
            "Received HTML instead of JavaScript. There may be a server issue."
          );
        }

        // Ensure response code is complete before transpiling
        try {
          if (isValidJavaScript(aiResponse)) {
            new Function(aiResponse); // Validate syntax
          } else {
            throw new Error("Invalid JavaScript code");
          }
          updateState((prevState) => ({
            code: aiResponse.trim(),
            isUpdating: false,
            history: [...prevState.history, prevState.code],
          }));
        } catch (err) {
          updateState({
            error: `AI response contains invalid JavaScript code: ${err.message}. Try refining the prompt.`,
            loadingStatus: "error",
            isUpdating: false,
          });
        }
      } catch (err) {
        updateState({
          error: `AI update failed: ${err.message}`,
          isUpdating: false,
        });
      }
    }, [state.aiPrompt, state.code]);

    const debouncedOnChange = useCallback(debounce((value) => {
      updateState({ aiPrompt: value });
    }, 300), []);

    const saveCustomPrompt = useCallback(() => {
      const newPrompts = [...state.customPrompts, state.aiPrompt];
      localStorage.setItem("customPrompts", JSON.stringify(newPrompts));
      updateState({ customPrompts: newPrompts });
    }, [state.aiPrompt, state.customPrompts]);

    const isValidJavaScript = (code) => {
      try {
        new Function(code);
        return true;
      } catch (err) {
        return false;
      }
    };

    const commonPrompts = [
      "Add a button",
      "Change color scheme",
      "Optimize performance",
    ];

    const undoLastChange = useCallback(() => {
      if (state.history.length > 0) {
        const lastCode = state.history[state.history.length - 1];
        updateState((prevState) => ({
          code: lastCode,
          history: prevState.history.slice(0, -1),
        }));
      }
    }, [state.history]);

    useEffect(() => {
      if (
        state.loadingStatus === "idle" &&
        state.code.trim() &&
        !state.isUpdating
      ) {
        renderComponent();
      }
    }, [state.code, renderComponent, state.loadingStatus, state.isUpdating]);

    return (
      <div className="flex flex-col md:flex-row gap-4">
        <div className="w-full md:w-1/2">
          <div className="mb-4">
            <input
              type="text"
              onChange={(e) => debouncedOnChange(e.target.value)}
              placeholder="Tell AI how to modify the code..."
              className="w-full p-2 border rounded mb-2"
              list="common-prompts"
            />
            <datalist id="common-prompts">
              {commonPrompts.map((prompt, index) => (
                <option key={index} value={prompt} />
              ))}
              {state.customPrompts.map((prompt, index) => (
                <option key={index + commonPrompts.length} value={prompt} />
              ))}
            </datalist>
            <button
              onClick={updateWithAI}
              disabled={state.isUpdating}
              className="w-full px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 disabled:bg-purple-300"
            >
              {state.isUpdating ? "Updating..." : "Update with AI"}
            </button>
            <button
              onClick={saveCustomPrompt}
              className="w-full px-4 py-2 mt-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Save Prompt
            </button>
            <button
              onClick={undoLastChange}
              className="w-full px-4 py-2 mt-2 bg-yellow-500 text-white rounded hover:bg-yellow-600"
            >
              Undo Last Change
            </button>
          </div>
          <textarea
            value={state.code}
            onChange={(e) => updateState({ code: e.target.value })}
            className="w-full h-[250px] font-mono text-sm p-4 border rounded"
            spellCheck="false"
          />
          {state.streamingResponse && (
            <div className="mt-4 p-4 bg-gray-50 rounded border">
              <p className="font-mono text-sm whitespace-pre-wrap">
                Processing AI response...
              </p>
            </div>
          )}
        </div>

        <div className="w-full md:w-1/2 border border-gray-200 rounded-lg bg-white shadow-lg h-[250px] overflow-y-auto">
          <div className="relative p-4 min-h-[200px] flex items-center justify-center">
            {state.loadingStatus !== "ready" &&
            state.loadingStatus !== "error" ? (
              <LoadingContent status={state.loadingStatus} />
            ) : state.error ? (
              <ErrorContent
                error={state.error}
                handleRetry={() => {
                  if (state.retryCount < MAX_RETRIES) {
                    updateState({ retryCount: state.retryCount + 1 });
                    renderComponent();
                  } else {
                    updateState({ retryCount: 0 });
                  }
                }}
              />
            ) : (
              state.preview
            )}
          </div>
        </div>
      </div>
    );
  }
);

const LoadingContent = React.memo(({ status }) => (
  <div className="flex items-center justify-center space-x-2">
    <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent" />
    <p className="text-gray-600 font-medium">
      {status === "loading" ? "Loading..." : "Rendering..."}
    </p>
  </div>
));

const ErrorContent = React.memo(({ error, handleRetry }) => (
  <div className="bg-red-50 border border-red-100 rounded p-4 w-full">
    <p className="text-red-600 text-sm font-medium">Error</p>
    <pre className="text-red-500 text-sm mt-1 font-mono whitespace-pre-wrap">
      {error}
    </pre>
    <button
      onClick={handleRetry}
      className="mt-2 text-blue-500 hover:underline focus:outline-none"
    >
      Retry
    </button>
  </div>
));

const StoryComponent = React.memo(() => (
  <div className="space-y-8 p-6 bg-gray-50">
    <div>
      <h2 className="text-lg font-semibold mb-3">Simple Component</h2>
      <MainComponent code={examples.simple} />
    </div>
    <div>
      <h2 className="text-lg font-semibold mb-3">Complex Component</h2>
      <MainComponent code={examples.complex} />
    </div>
  </div>
));

module.exports = StoryComponent;
