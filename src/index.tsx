import { useState, useEffect, useCallback, useRef } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Marked } from 'marked';
import { markedHighlight } from "marked-highlight";
import hljs from 'highlight.js';

import './font.css';
import "highlight.js/styles/base16/framer.css";

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
  systemPrompt: string;
  lastMessage: any;
  conversations: string[];
  loadedConversation: Message[] | null;
  sendMessage: (message: ArrakisRequest) => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  error: Error | null;
}

type Message = {
  message_type: "System" | "User" | "Assistant";
  content: string;
  model: string;
  system_prompt: string;
};

type Conversation = {
  method: 'Completion';
  name: string;
  conversation: Message[];
};

type SystemPrompt = {
  method: 'SystemPrompt';
  content: string;
  write: boolean;
};

type Ping = {
  method: 'Ping';
  body: string;
};

type Load = {
  method: 'Load',
  name: string;
};

type ArrakisRequest = {
  payload: Ping | Conversation | { method: 'ConversationList' } | Load | SystemPrompt;
};

type Completion = {
  method: 'Completion';
  stream: boolean;
  delta: string;
};

type ConversationList = {
  conversations: string[];
};

type ArrakisResponse = {
  payload: Completion | Ping | ConversationList | SystemPrompt;
};

// TODO: disgusting mixing of concerns between this and the main page
//       should probably centralize everything dealing with message responses
//       in here + separate away from rendering

const useWebSocket = ({
  url,
  retryInterval = 5000,
  maxRetries = 0
}: WebSocketHookOptions): WebSocketHookReturn => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<string>('');
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [conversations, setConversations] = useState<string[]>([]);
  const [loadedConversation, setLoadedConversation] = useState<Message[] | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setConnectionStatus('connected');
        setError(null);
        setRetryCount(0);
      };

      ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data) satisfies ArrakisResponse;
          console.log(response);
          if (response.payload.method === 'Completion') {
            setLastMessage((response.payload satisfies Completion).delta);
          } else if (response.payload.method === 'Ping' && connectionStatus !== 'connected') {
            setConnectionStatus('connected');
          } else if (response.payload.method === 'ConversationList') {
            setConversations((response.payload satisfies ConversationList).conversations);
          } else if (response.payload.method === 'Load') {
            setLoadedConversation((response.payload satisfies Conversation).conversation);
          } else if (response.payload.method === 'SystemPrompt') {
            setSystemPrompt(response.payload.content);
          }
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

      setSocket(ws);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to create WebSocket connection'));
    }
  }, [url, retryCount, maxRetries, retryInterval]);

  const sendMessage = useCallback((message: ArrakisRequest) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
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

  return { socket, systemPrompt, conversations, loadedConversation, lastMessage, sendMessage, connectionStatus, error };
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

type ReactElementOrText = React.ReactElement | string | null;
function htmlToReactElements(htmlString: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  function domToReact(node: Node): ReactElementOrText {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const elementNode = node as HTMLElement;

      const tagName = (() => {
        const tn = elementNode.tagName.toLowerCase();
        return tn;
      })();

      const props: Record<string, string> = {};
      Array.from(elementNode.attributes).forEach(attr => {
        let name = attr.name;
        if (name === 'class') name = 'className';
        if (name === 'for') name = 'htmlFor';

        props[name] = attr.value;
      });

      const children = Array.from(elementNode.childNodes).map(domToReact);

      return React.createElement(tagName, props, ...children);
    }

    return null;
  }

  return Array.from(doc.body.childNodes).map(domToReact);
}

const escapeToHTML: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;'
};

const escapeFromHTML: Record<string, string> = Object.entries(escapeToHTML).reduce((acc, [key, value]) => {
  acc[value as string] = key;
  return acc;
}, {} as Record<string, string>);

function MainPage() {
  const {
    connectionStatus,
    systemPrompt,
    conversations,
    loadedConversation,
    lastMessage,
    sendMessage,
  } = useWebSocket({
    url: 'ws://localhost:9001',
    retryInterval: 5000,
    maxRetries: 0
  });

  const [conversationName, setConversationName] = useState(crypto.randomUUID());

  const [selectedModal, setSelectedModal] = useState<string | null>(null);
  const [mouseInChat, setMouseInChat] = useState<boolean>(false);

  // TODO: ???
  const [inputSizings, _] = useState({
    height: createSizing(0, 'px'),
    padding: createSizing(0.75, 'em'),
    margin: createSizing(1, 'em'),
  });

  const [messages, setMessages] = useState([] as Message[]);

  const messagesRef = useRef() as React.MutableRefObject<HTMLDivElement>;

  useEffect(() => {
    if (connectionStatus === 'connected') {
      sendMessage({
        payload: {
          method: 'SystemPrompt',
          write: false,
          content: '',
        } satisfies SystemPrompt
      } satisfies ArrakisRequest);

    }
  }, [connectionStatus]);

  useEffect(() => {
    const handleKeyPress = (event: any) => {
      if (selectedModal) {
        if (mouseInChat) {
          (document.getElementById('chatInput') as HTMLInputElement).focus();
          return;
        } else {
          // TODO: actually do something with search here
          if (selectedModal !== 'search') {
            (document.getElementById(selectedModal === 'search' ? 'searchInput' : (selectedModal === 'prompt' ? 'promptInput' : '')) as HTMLInputElement).focus();
            return;
          }
        }
      }

      if (event.ctrlKey && event.key !== 'v') {
        return;
      }

      (document.getElementById('chatInput') as HTMLInputElement).focus();
    }

    document.addEventListener('keydown', handleKeyPress);

    return () => {
      document.removeEventListener('keydown', handleKeyPress);
    };
  }, [selectedModal, mouseInChat]);

  useEffect(() => {
    const last = messages[messages.length - 1];

    if (last) {
      const newMessages = [...messages.slice(0, messages.length - 1)];

      last.content += lastMessage;
      newMessages.push(last);

      setMessages(newMessages);

      if (messagesRef.current) {
        messagesRef.current.scrollTo({
          top: messagesRef.current.scrollHeight,
          behavior: 'smooth'
        });
      }
    }
  }, [lastMessage]);

  useEffect(() => {
    console.log('checking loaded conv:', loadedConversation);
    if (loadedConversation) {
      setMessages(loadedConversation);
    }
  }, [loadedConversation]);

  // TODO: need to plan out Chamber integration better
  //       i think the current plan is 
  //       to only have a checkbox for Dewey
  //       + use the retrieved info in the given prompt
  //       without Dewey, this will just be a standard chat
  const sendPrompt = (e: any) => {
    const inputElement = document.getElementById('chatInput') as HTMLDivElement;
    if (e.key === 'Enter') {
      if (!e.shiftKey) {
        e.preventDefault();
        const data = inputElement.innerText;

        const newMessages = [
          ...messages,
          { content: data, message_type: 'User', model: 'anthropic', system_prompt: '' } satisfies Message,
          { content: '', message_type: 'Assistant', model: 'anthropic', system_prompt: '' } satisfies Message,
        ];

        setMessages(newMessages);

        sendMessage({
          payload: {
            method: 'Completion',
            name: conversationName,
            conversation: newMessages,
          } satisfies Conversation
        } satisfies ArrakisRequest);

        inputElement.innerHTML = '';
      }
    }
  };

  useEffect(() => {
    const pingInterval = setInterval(() => {
      sendMessage({
        payload: {
          method: 'Ping',
          body: 'ping',
        } satisfies Ping,
      } satisfies ArrakisRequest);
    }, 5000);

    // Clean up interval when component unmounts
    return () => clearInterval(pingInterval);
  }, [sendMessage]);

  useEffect(() => {
    sendMessage({
      payload: {
        method: 'ConversationList'
      }
    } satisfies ArrakisRequest);
  }, [selectedModal]);

  const getModal = () => {
    if (selectedModal === 'search') {
      const getConversationCallback = (c: string) => {
        return () => {
          sendMessage({
            payload: {
              method: 'Load',
              name: c,
            } satisfies Load
          } satisfies ArrakisRequest);
        };
      };


      return (
        <div style={{
          margin: '0.5rem',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {/*
          <input id="searchInput" type="text" placeholder="Search conversations" style={{
            border: 0,
            position: 'relative',
            top: '1px',
            outline: 0,
            borderRadius: '0.5rem',
            fontSize: '16px',
            padding: '0.5rem',
            marginBottom: '0.5rem',
          }} />
          */}
          {conversations.map(c => (
            <div className="buttonHover" onClick={getConversationCallback(c)} style={{
              padding: '0.5rem',
              cursor: 'pointer',
              userSelect: 'none',
              borderRadius: '0.5rem',
            }}>
              {c.replace('.json', '')}
            </div>
          ))}
        </div>
      );
    } else if (selectedModal === 'prompt') {
      return (
        <div style={{
          margin: '0.5rem',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <textarea id="promptInput" placeholder="You are a helpful assistant." style={{
            border: 0,
            position: 'relative',
            top: '1px',
            outline: 0,
            resize: 'none',
            height: '45vh',
            borderRadius: '0.5rem',
            fontSize: '16px',
            padding: '0.5rem',
            marginBottom: '0.5rem',
          }} onKeyDown={() => {
            sendMessage({
              payload: {
                method: 'SystemPrompt',
                write: true,
                content: (document.getElementById('promptInput')! as HTMLTextAreaElement).value,
              } satisfies SystemPrompt
            } satisfies ArrakisRequest);
          }}>{systemPrompt}</textarea>
        </div>
      );
    }
  };


  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'row',
    }}>
      <div style={{
        width: '5vw',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'transparent',
        margin: '0.5rem 0 0.5rem 0.5rem',
      }}>
        <div style={{
          backgroundColor: connectionStatus === 'disconnected' ? 'red' : '#56f55e',
          userSelect: 'none',
          width: '24px',
          height: '24px',
          margin: '0.5rem',
          borderRadius: '0.5rem',
          alignSelf: 'center',
        }} />
        <div className="buttonHover" onClick={() => {
          setMessages([]);
          setConversationName(crypto.randomUUID());
        }} style={{
          userSelect: 'none',
          cursor: 'pointer',
          width: '100%',
          height: '2rem',
          alignSelf: 'center',
          borderBottom: '1px solid #DFDFDF',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
          margin: '0.25rem 0',
          borderRadius: '0.5rem',
        }}>New</div>
        <div className="buttonHover" onClick={() => setSelectedModal(selectedModal !== 'search' ? 'search' : null)} style={{
          userSelect: 'none',
          cursor: 'pointer',
          width: '100%',
          height: '2rem',
          alignSelf: 'center',
          borderBottom: '1px solid #DFDFDF',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
          margin: '0.25rem 0',
          borderRadius: '0.5rem',
        }}>History</div>
        <div className="buttonHover" onClick={() => setSelectedModal(selectedModal !== 'model' ? 'model' : null)} style={{
          userSelect: 'none',
          cursor: 'pointer',
          height: '2rem',
          width: '100%',
          alignSelf: 'center',
          borderBottom: '1px solid #DFDFDF',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
          margin: '0.25rem 0',
          borderRadius: '0.5rem',
        }}>Models</div>
        <div className="buttonHover" onClick={() => setSelectedModal(selectedModal !== 'prompt' ? 'prompt' : null)} style={{
          userSelect: 'none',
          cursor: 'pointer',
          height: '2rem',
          width: '100%',
          alignSelf: 'center',
          borderBottom: '1px solid #DFDFDF',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
          margin: '0.25rem 0',
          borderRadius: '0.5rem',
        }}>Prompt</div>
      </div>
      <div className="slideOut" style={{
        width: selectedModal ? '30vw' : 0,
        overflow: 'hidden',
      }}>
        {getModal()}
      </div>
      <div ref={messagesRef} onMouseEnter={() => setMouseInChat(true)} onMouseLeave={() => setMouseInChat(false)} style={{
        height: 'calc(100vh - 1rem)',
        display: 'flex',
        flexDirection: 'column',
        width: 'calc(100% - 1rem)',
        overflowY: 'auto',
        border: '1px solid #DFDFDF',
        margin: '0.5rem',
        backgroundColor: '#F8F9FA',
        borderRadius: '0.5rem',
      }}>
        <div style={{
          position: 'relative',
          width: '40vw',
          margin: '0 auto',
          flex: 1,
          paddingBottom: `calc(${inputSizings.height.toString()} + 10vh)`
        }}>
          {messages.map((m) => {
            const toPattern = new RegExp(
              Object.keys(escapeToHTML)
                .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|'),
              'g'
            );

            let content = marked.parse(m.content.replace(toPattern, function(match) {
              return escapeToHTML[match];
            })) as string;

            const reactElements = htmlToReactElements(content);

            function modifyElements(element: any): ReactElementOrText {
              if (typeof element === 'string') {
                let c = element as string;
                const fromPattern = new RegExp(
                  Object.keys(escapeFromHTML)
                    .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('|'),
                  'g'
                );

                return c.replace(fromPattern, function(match) {
                  return escapeFromHTML[match];
                })
              }

              const props = element.props as React.PropsWithChildren<{ [key: string]: any }>;
              if (props.children) {
                return React.createElement(
                  element.type,
                  element.props,
                  React.Children.map(props.children, modifyElements)
                );
              }

              return element;
            };

            const unescapedElements = reactElements.map(modifyElements);

            const isUser = m.message_type === 'User';
            return (
              <div style={{
                backgroundColor: isUser ? '#CDCDCD' : '',
                borderRadius: '0.5rem',
                margin: '0.25rem',
                padding: '0.01rem 0.5rem',
                fontFamily: isUser ? 'monospace' : '',
              }}>{unescapedElements}</div>
            );
          })}
        </div>
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: '3vh',
            width: '40vw',
            minHeight: '1rem',
            padding: inputSizings.padding.toString(),
            backgroundColor: '#EDEDED',
            borderRadius: '0.5rem',
            fontSize: '16px',
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          <button
            className="buttonHover"
            style={{
              marginRight: '0.5rem',
              height: 'fit-content',
              border: 0,
            }}
          >
            +
          </button>
          <div style={{
            maxHeight: '25vh',
            overflow: 'auto',
            height: '100%',
            width: '100%',
          }}>
            <div
              contentEditable={true}
              id="chatInput"
              onKeyDown={sendPrompt}
              style={{
                height: '100%',
                width: '100%',
                border: 0,
                outline: 0,
                resize: 'none',
                alignSelf: 'center',
                backgroundColor: 'transparent',
              }}
            />
          </div>
        </div>
      </div>
    </div >
  );
}

root.render(
  <MainPage />
);
