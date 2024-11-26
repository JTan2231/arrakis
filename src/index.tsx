import { useState, useEffect, useCallback } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Marked } from 'marked';
import { markedHighlight } from "marked-highlight";
import hljs from 'highlight.js';

import './font.css';
import "highlight.js/styles/github.css";

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang, info) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    }
  })
);

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

interface WebSocketHookOptions {
  url: string;
  retryInterval?: number;
  maxRetries?: number;
}

interface WebSocketHookReturn {
  socket: WebSocket | null;
  lastMessage: any;
  sendMessage: (message: string | object) => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  error: Error | null;
}

const useWebSocket = ({
  url,
  retryInterval = 5000,
  maxRetries = 0
}: WebSocketHookOptions): WebSocketHookReturn => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<any>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      setSocket(ws);
      setConnectionStatus('connecting');

      ws.onopen = () => {
        setConnectionStatus('connected');
        setError(null);
        setRetryCount(0);
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          setLastMessage(parsed);
        } catch {
          setLastMessage(event.data);
        }
      };

      ws.onerror = (event) => {
        setError(new Error('WebSocket error occurred'));
      };

      ws.onclose = () => {
        setConnectionStatus('disconnected');
        setSocket(null);

        if (retryCount < maxRetries) {
          setTimeout(() => {
            setRetryCount(prev => prev + 1);
            connect();
          }, retryInterval);
        }
      };
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to create WebSocket connection'));
    }
  }, [url, retryCount, maxRetries, retryInterval]);

  const sendMessage = useCallback((message: string | object) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    } else {
      setError(new Error('WebSocket is not connected'));
    }
  }, [socket]);

  useEffect(() => {
    connect();
    return () => {
      if (socket) {
        socket.close();
      }
    };
  }, [connect]);

  return { socket, lastMessage, sendMessage, connectionStatus, error };
};

interface Sizing {
  value: number;
  unit: string;
  toString(): string;
}

function createSizing(value: number, unit: string): Sizing {
  return {
    value, unit, toString: () => { return `${value}${unit}`; }
  };
}

function scale(scalar: number, size: Sizing): Sizing {
  return createSizing(size.value * scalar, size.unit);
}

type Message = {
  role: string;
  content: string;
};

function MainPage() {
  const {
    lastMessage,
    sendMessage,
    connectionStatus,
    error
  } = useWebSocket({
    url: 'ws://localhost:9001',
    retryInterval: 5000,
    maxRetries: 0
  });

  // this setter shouldn't be called directly
  // see setInputLines as a wrapper which calls this
  const [inputLines, _setInputLines] = useState(1);

  const [inputSizings, setInputSizings] = useState({
    height: createSizing(1.25, 'em'),
    padding: createSizing(0.75, 'em'),
    margin: createSizing(1, 'em'),
  });

  const [usingDewey, setUsingDewey] = useState(false);
  const [messages, setMessages] = useState([] as Message[]);

  const setInputLines = (lines: number) => {
    setInputSizings({
      ...inputSizings,
      height: createSizing(1.25 * Math.max(1, Math.min(5, lines)) + (lines > 1 ? inputSizings.padding.value : 0), 'em')
    });

    _setInputLines(lines);
  };

  useEffect(() => {
    const handleKeyPress = (event: any) => {
      (document.getElementById('chatInput') as HTMLInputElement).focus();
    }

    document.addEventListener('keydown', handleKeyPress);

    return () => {
      document.removeEventListener('keydown', handleKeyPress);
    };
  }, []);

  useEffect(() => {
    // do something with last received message
  }, [lastMessage]);

  // TODO: need to plan out Chamber integration better
  //       i think the current plan is 
  //       to only have a checkbox for Dewey
  //       + use the retrieved info in the given prompt
  //       without Dewey, this will just be a standard chat
  const sendPrompt = (e: any) => {
    const inputElement = document.getElementById('chatInput') as HTMLInputElement;
    if (e.key === 'Enter') {
      if (!e.shiftKey) {
        e.preventDefault();
        const data = inputElement.value;

        // TODO: handle Dewey request/response
        if (usingDewey) {
          sendMessage(data);
        }

        const newMessages = [...messages, { content: data, role: 'user' }];
        setMessages(newMessages);

        inputElement.value = '';
      } else {
        setInputLines(inputLines + 1);
      }
    } else if (e.key === 'Backspace') {
      setInputLines((() => {
        let lines = 1;
        for (const c of inputElement.value) {
          lines += c == '\n' ? 1 : 0;
        }

        return lines;
      })());
    }
  };

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      overflowY: 'auto',
    }}>
      <div style={{
        position: 'relative',
        width: '40vw',
        margin: '0 auto',
        flex: 1,
        paddingBottom: `calc(${inputSizings.height.toString()} + 50px)`
      }}>
        {messages.map((m) => (
          <div style={{
            backgroundColor: m.role === 'user' ? '#90C3F5' : '',
            whiteSpace: 'pre-wrap',
            borderRadius: '0.5rem',
            margin: '0.25rem',
            padding: '1.5rem',
          }} dangerouslySetInnerHTML={{ __html: marked.parse(m.content) as string }} />
        ))}
      </div>
      <textarea
        id="chatInput"
        placeholder="Send Message"
        onKeyDown={sendPrompt}
        style={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: '25px',
          width: '40vw',
          height: inputSizings.height.toString(),
          padding: inputSizings.padding.toString(),
          backgroundColor: '#EDEDED',
          borderRadius: '0.5rem',
          border: 0,
          resize: 'none',
          outline: 0,
          fontSize: '16px',
          overflow: 'hidden',
        }}
      />
    </div>
  );
}

root.render(
  <MainPage />
);
