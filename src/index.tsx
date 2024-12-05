import { useState, useEffect, useCallback, useRef } from 'react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Marked } from 'marked';
import { markedHighlight } from "marked-highlight";
import { z } from 'zod';
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
  conversations: Conversation[];
  loadedConversation: Conversation;
  setLoadedConversation: Function;
  sendMessage: (message: ArrakisRequest) => void;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  error: Error | null;
}

const MessageSchema = z.object({
  message_type: z.enum(["System", "User", "Assistant"]),
  id: z.number().nullable(),
  content: z.string(),
  model: z.string(),
  system_prompt: z.string(),
  sequence: z.number(),
});

const ConversationSchema = z.object({
  id: z.number().nullable(),
  name: z.string(),
  messages: z.array(MessageSchema),
});

const CompletionRequestSchema = ConversationSchema;

const SystemPromptRequestSchema = z.object({
  content: z.string(),
  write: z.boolean(),
});

const PingRequestSchema = z.object({
  body: z.string(),
});

const LoadRequestSchema = z.object({
  id: z.number(),
});

const ConversationListRequestSchema = z.object({});

const CompletionResponseSchema = z.object({
  stream: z.boolean(),
  delta: z.string(),
  name: z.string(),
  conversationId: z.number(),
  requestId: z.number(),
  responseId: z.number(),
});

const SystemPromptResponseSchema = SystemPromptRequestSchema;

const PingResponseSchema = PingRequestSchema;

const ConversationListResponseSchema = z.object({
  conversations: z.array(ConversationSchema),
});

const ArrakisRequestSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("ConversationList"),
  }),
  z.object({
    method: z.literal("Ping"),
    payload: PingRequestSchema,
  }),
  z.object({
    method: z.literal("Completion"),
    payload: CompletionRequestSchema,
  }),
  z.object({
    method: z.literal("Load"),
    payload: LoadRequestSchema,
  }),
  z.object({
    method: z.literal("SystemPrompt"),
    payload: SystemPromptRequestSchema,
  }),
]);

const ArrakisResponseSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("ConversationList"),
    payload: ConversationListResponseSchema,
  }),
  z.object({
    method: z.literal("Ping"),
    payload: PingResponseSchema,
  }),
  z.object({
    method: z.literal("Completion"),
    payload: CompletionResponseSchema,
  }),
  z.object({
    method: z.literal("SystemPrompt"),
    payload: SystemPromptResponseSchema,
  }),
]);

type Message = z.infer<typeof MessageSchema>;
type Conversation = z.infer<typeof ConversationSchema>;
type CompletionRequest = z.infer<typeof CompletionRequestSchema>;
type SystemPromptRequest = z.infer<typeof SystemPromptRequestSchema>;
type PingRequest = z.infer<typeof PingRequestSchema>;
type LoadRequest = z.infer<typeof LoadRequestSchema>;
type ConversationListRequest = z.infer<typeof ConversationListRequestSchema>;
type CompletionResponse = z.infer<typeof CompletionResponseSchema>;
type SystemPromptResponse = z.infer<typeof SystemPromptResponseSchema>;
type PingResponse = z.infer<typeof PingResponseSchema>;
type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;
type ArrakisRequest = z.infer<typeof ArrakisRequestSchema>;
type ArrakisResponse = z.infer<typeof ArrakisResponseSchema>;

// TODO: disgusting mixing of concerns between this and the main page
//       should probably centralize everything dealing with message responses
//       in here + separate away from rendering

interface TitleCaseOptions {
  preserveAcronyms?: boolean;
  handleHyphens?: boolean;
  customMinorWords?: string[];
}

function formatTitle(input: string, options: TitleCaseOptions = {}): string {
  if (!input) return '';

  const {
    preserveAcronyms = true,
    handleHyphens = true,
    customMinorWords = [],
  } = options;

  const MINOR_WORDS = new Set([
    'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'yet', 'so',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    ...customMinorWords
  ]);

  const isAcronym = (word: string): boolean => {
    return /^[A-Z0-9]+$/.test(word);
  };

  const capitalizeWord = (word: string, forceCapitalize: boolean = false): string => {
    if (preserveAcronyms && isAcronym(word)) {
      return word;
    }

    const wordLower = word.toLowerCase();

    if (forceCapitalize || !MINOR_WORDS.has(wordLower)) {
      return word.charAt(0).toUpperCase() + wordLower.slice(1);
    }

    return wordLower;
  };

  const processHyphenatedWord = (word: string, forceCapitalize: boolean): string => {
    if (!handleHyphens) return capitalizeWord(word, forceCapitalize);

    return word = word
      .split('-')
      .map((part, index) => capitalizeWord(part, index === 0 && forceCapitalize))
      .join('-');
  };

  const words = input.split(/\s+/);

  const capitalizedWords = words.map((word, index) => {
    const isFirst = index === 0;
    const isLast = index === words.length - 1;

    return processHyphenatedWord(word, isFirst || isLast);
  });

  return capitalizedWords.join(' ').replace('.json', '').replaceAll('_', ' ');
}

function conversationDefault(): Conversation {
  return ConversationSchema.parse({ id: null, name: crypto.randomUUID(), messages: [] });
}

const useWebSocket = ({
  url,
  retryInterval = 5000,
  maxRetries = 0
}: WebSocketHookOptions): WebSocketHookReturn => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadedConversation, setLoadedConversation] = useState<Conversation>(conversationDefault());
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
          if (response.payload.method === 'Completion') {
            setLoadedConversation(prev => {
              const completion = CompletionResponseSchema.parse(response.payload);

              const lcm = prev.messages;
              const newMessages = [...lcm.slice(0, lcm.length - 1)];

              const last = lcm[lcm.length - 1];
              last.content += completion.delta;
              last.id = completion.responseId;

              newMessages[newMessages.length - 1].id = completion.requestId;
              newMessages.push(last);

              return { id: completion.conversationId, name: completion.name, messages: newMessages };
            });
          } else if (response.payload.method === 'Ping' && connectionStatus !== 'connected') {
            setConnectionStatus('connected');
          } else if (response.payload.method === 'ConversationList') {
            const conversationList = ConversationListResponseSchema.parse(response.payload);
            setConversations(conversationList.conversations);
          } else if (response.payload.method === 'Load') {
            const conversation = ConversationSchema.parse(response.payload);
            setLoadedConversation(conversation);
          } else if (response.payload.method === 'SystemPrompt') {
            setSystemPrompt(response.payload.content);
          }
        } catch (error) {
          console.log(error);
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

  return {
    socket,
    systemPrompt,
    conversations,
    loadedConversation,
    setLoadedConversation,
    sendMessage,
    connectionStatus,
    error
  };
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
    setLoadedConversation,
    sendMessage,
  } = useWebSocket({
    url: 'ws://localhost:9001',
    retryInterval: 5000,
    maxRetries: 0
  });

  const [selectedModal, setSelectedModal] = useState<string | null>(null);
  const [mouseInChat, setMouseInChat] = useState<boolean>(false);

  const titleDefault = () => ({ title: '', index: 0 });
  const [displayedTitle, setDisplayedTitle] = useState<{ title: string; index: number; }>(titleDefault());

  // TODO: ???
  const [inputSizings, _] = useState({
    height: createSizing(0, 'px'),
    padding: createSizing(0.75, 'em'),
    margin: createSizing(1, 'em'),
  });

  const messagesRef = useRef() as React.MutableRefObject<HTMLDivElement>;

  useEffect(() => {
    if (connectionStatus === 'connected') {
      sendMessage({
        method: 'SystemPrompt',
        payload: {
          write: false,
          content: '',
        } satisfies SystemPromptRequest
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

  function isGuid(str: string): boolean {
    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return guidRegex.test(str);
  }

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTo({
        top: messagesRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }

    let intervalId: any = null;
    if (!isGuid(loadedConversation.name)) {
      const intervalId = setInterval(() => {
        const conversationName = loadedConversation.name;

        if (displayedTitle.index < conversationName.length) {
          setDisplayedTitle(prev => {
            if (prev.index < conversationName.length) {
              return { title: prev.title + conversationName[prev.index], index: prev.index + 1 };
            } else {
              return prev;
            }
          });
        } else {
          clearInterval(intervalId);
        }
      }, 50);
    }

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
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

        const messages = loadedConversation.messages;
        const newMessages = [
          ...messages,
          {
            id: messages.length > 0 ? messages[messages.length - 1].id! + 1 : null,
            content: data,
            message_type: 'User',
            model: 'anthropic',
            system_prompt: '',
            sequence: messages.length
          } satisfies Message,
          {
            id: messages.length > 0 ? messages[messages.length - 1].id! + 2 : null,
            content: '',
            message_type: 'Assistant',
            model: 'anthropic',
            system_prompt: '',
            sequence: messages.length + 1
          } satisfies Message,
        ];

        const newConversation = {
          ...loadedConversation,
          messages: newMessages,
        };

        setLoadedConversation(newConversation);

        sendMessage({
          method: 'Completion',
          payload: newConversation,
        } satisfies ArrakisRequest);

        inputElement.innerHTML = '';
      }
    }
  };

  useEffect(() => {
    const pingInterval = setInterval(() => {
      sendMessage(ArrakisRequestSchema.parse({
        method: 'Ping',
        payload: {
          body: 'ping',
        } satisfies PingRequest,
      }));
    }, 5000);

    // Clean up interval when component unmounts
    return () => clearInterval(pingInterval);
  }, [sendMessage]);

  useEffect(() => {
    sendMessage({
      method: 'ConversationList',
    } satisfies ArrakisRequest);
  }, [selectedModal]);

  const getModal = () => {
    if (selectedModal === 'search') {
      const getConversationCallback = (id: number) => {
        return () => {
          setDisplayedTitle(titleDefault());
          setSelectedModal(null);
          sendMessage({
            method: 'Load',
            payload: {
              id,
            } satisfies LoadRequest
          } satisfies ArrakisRequest);
        };
      };


      return (
        <div style={{
          margin: '0.5rem',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100vh - 1rem)',
        }}>
          {conversations.map(c => {
            return (
              <div className="buttonHover" onClick={getConversationCallback(c.id!)} style={{
                padding: '0.5rem',
                cursor: 'pointer',
                userSelect: 'none',
                borderRadius: '0.5rem',
              }}>
                {formatTitle(c.name)}
              </div>
            );
          })}
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
              method: 'SystemPrompt',
              payload: {
                write: true,
                content: (document.getElementById('promptInput')! as HTMLTextAreaElement).value,
              } satisfies SystemPromptRequest
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
          setLoadedConversation(conversationDefault());
          setDisplayedTitle(titleDefault());
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
        { /*
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
      */ }
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
          position: 'sticky',
          top: '0.5rem',
          marginLeft: '0.5rem',
          fontWeight: 'bold',
        }}>{formatTitle(displayedTitle.title)}</div>
        <div style={{
          position: 'relative',
          width: '40vw',
          margin: '0 auto',
          flex: 1,
          paddingBottom: `calc(${inputSizings.height.toString()} + 10vh)`
        }}>
          {loadedConversation.messages.map((m) => {
            const toPattern = new RegExp(
              Object.keys(escapeToHTML)
                .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|'),
              'g'
            );

            let content = marked.parse(m.content.replace(toPattern, function (match) {
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

                return c.replace(fromPattern, function (match) {
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
