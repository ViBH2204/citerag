// import React, { useState, useEffect, useRef } from 'react';
// import ReactMarkdown from 'react-markdown';
// import remarkGfm from 'remark-gfm';
// import CitationList from './CitationList';
// import RetrievedChunks from './RetrievedChunks';
// import PipelineStages from './PipelineStages';
// import { queryConversationStream, createConversation } from '../services/api';

// /**
//  * Chat component for querying the pre-ingested persistent document corpus.
//  */
// function GlobalChat() {
//   const [inputText, setInputText] = useState('');
//   const [submittedQuery, setSubmittedQuery] = useState('');
//   const [answer, setAnswer] = useState('');
//   const [citations, setCitations] = useState([]);
//   const [chunks, setChunks] = useState([]);
//   const [isPending, setIsPending] = useState(false);
//   const [error, setError] = useState(null);
//   const [conversationId, setConversationId] = useState(null);

//   const activeStreamRef = useRef(0);

//   useEffect(() => {
//     let cancelled = false;
//     createConversation()
//       .then((data) => {
//         if (!cancelled) {
//           setConversationId(data.conversation_id);
//         }
//       })
//       .catch((err) => {
//         if (!cancelled) {
//           console.error('Failed to create conversation:', err);
//         }
//       });
//     return () => {
//       cancelled = true;
//     };
//   }, []);

//   const handleSubmit = async (e) => {
//     e.preventDefault();
//     const query = inputText.trim();
//     if (!query || isPending) return;

//     const generation = ++activeStreamRef.current;

//     setSubmittedQuery(query);
//     setIsPending(true);
//     setAnswer('');
//     setCitations([]);
//     setChunks([]);
//     setError(null);

//     try {
//       const convId = conversationId;
//       if (!convId) {
//         throw new Error('Conversation session is not ready. Please wait a moment and try again.');
//       }

//       let accAnswer = '';

//       for await (const event of queryConversationStream(convId, query)) {
//         if (generation !== activeStreamRef.current) return;

//         if (event.type === 'token') {
//           accAnswer += event.text;
//           setAnswer(accAnswer);
//         } else if (event.type === 'sources') {
//           setCitations(event.data ?? []);
//         } else if (event.type === 'chunks') {
//           setChunks(event.data ?? []);
//         } else if (event.type === 'end') {
//           setIsPending(false);
//         }
//       }

//       if (generation === activeStreamRef.current) {
//         setIsPending(false);
//       }
//     } catch (err) {
//       if (generation !== activeStreamRef.current) return;
//       setIsPending(false);
//       setError(err.message || 'The query could not be answered. Please try again.');
//     }
//   };

//   const handleKeyDown = (e) => {
//     if (e.key === 'Enter' && !e.shiftKey) {
//       e.preventDefault();
//       handleSubmit(e);
//     }
//   };

//   const hasAnswer = answer.length > 0;
//   const hasResult = hasAnswer || citations.length > 0 || chunks.length > 0;

//   return (
//     <div>
//       {/* Pipeline stages */}
//       <PipelineStages />

//       {/* Chat Panel */}
//       <section className="chat-panel" aria-label="Chat interface">
//         <form
//           className="chat-form"
//           onSubmit={handleSubmit}
//           aria-label="Submit a question"
//         >
//           <label htmlFor="query-input" className="chat-label">
//             Ask a question
//           </label>
//           <textarea
//             id="query-input"
//             className="chat-input"
//             value={inputText}
//             onChange={(e) => setInputText(e.target.value)}
//             onKeyDown={handleKeyDown}
//             placeholder="Type your question and press Enter or click Ask…"
//             rows={3}
//             disabled={isPending}
//             aria-label="Query input"
//             aria-describedby={error ? 'chat-error' : undefined}
//           />
//           <button
//             type="submit"
//             className="chat-submit-btn"
//             disabled={isPending || !inputText.trim()}
//             aria-busy={isPending}
//           >
//             {isPending ? 'Generating…' : 'Ask'}
//           </button>
//         </form>

//         {isPending && (
//           <div
//             className="chat-pending"
//             role="status"
//             aria-live="polite"
//             aria-label="Generating answer"
//           >
//             <span className="chat-spinner" aria-hidden="true" />
//             <span>Generating answer…</span>
//           </div>
//         )}

//         {error && !isPending && (
//           <div
//             id="chat-error"
//             className="chat-error"
//             role="alert"
//             aria-live="assertive"
//           >
//             <span className="chat-error-icon" aria-hidden="true">⚠️</span>
//             <span>
//               The query &ldquo;{submittedQuery}&rdquo; could not be answered. {error}
//             </span>
//           </div>
//         )}

//         {hasAnswer && !isPending && !error && (
//           <section className="chat-answer" aria-label="Answer">
//             <h2 className="chat-answer-heading">Answer</h2>
//             <div className="chat-answer-body">
//               <ReactMarkdown remarkPlugins={[remarkGfm]}>
//                 {answer}
//               </ReactMarkdown>
//             </div>
//           </section>
//         )}

//         {hasAnswer && isPending && (
//           <section className="chat-answer chat-answer--streaming" aria-label="Answer (streaming)">
//             <h2 className="chat-answer-heading">Answer</h2>
//             <div className="chat-answer-body">
//               <ReactMarkdown remarkPlugins={[remarkGfm]}>
//                 {answer}
//               </ReactMarkdown>
//             </div>
//           </section>
//         )}
//       </section>

//       {hasResult && !isPending && !error && (
//         <section className="chat-citations" aria-label="Citations">
//           <h2 className="chat-section-heading">Sources</h2>
//           <CitationList citations={citations} />
//         </section>
//       )}

//       {hasResult && !isPending && !error && (
//         <section className="chat-chunks" aria-label="Retrieved passages">
//           <RetrievedChunks chunks={chunks} />
//         </section>
//       )}
//     </div>
//   );
// }

// export default GlobalChat;



import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CitationList from './CitationList';
import RetrievedChunks from './RetrievedChunks';
import PipelineStages from './PipelineStages';
import { queryConversationStream, createConversation } from '../services/api';

function GlobalChat() {
  const [inputText, setInputText] = useState('');
  const [messages, setMessages] = useState([]);
  const [isPending, setIsPending] = useState(false);
  const [conversationId, setConversationId] = useState(null);

  const activeStreamRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    createConversation()
      .then((data) => {
        if (!cancelled) {
          setConversationId(data.conversation_id);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to create conversation:', err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateMessage = (id, updates) => {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === id
          ? { ...message, ...updates }
          : message
      )
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const query = inputText.trim();

    if (!query || isPending) return;

    if (!conversationId) {
      return;
    }

    const generation = ++activeStreamRef.current;
    const messageId = generation;

    // Add a new message instead of replacing previous messages.
    setMessages((previous) => [
      ...previous,
      {
        id: messageId,
        query,
        answer: '',
        citations: [],
        chunks: [],
        error: null,
        status: 'pending',
      },
    ]);

    // Clear the question input after submission.
    setInputText('');
    setIsPending(true);

    try {
      let accAnswer = '';

      for await (const event of queryConversationStream(
        conversationId,
        query
      )) {
        if (generation !== activeStreamRef.current) return;

        if (event.type === 'token') {
          accAnswer += event.text;

          updateMessage(messageId, {
            answer: accAnswer,
          });
        } else if (event.type === 'sources') {
          updateMessage(messageId, {
            citations: event.data ?? [],
          });
        } else if (event.type === 'chunks') {
          updateMessage(messageId, {
            chunks: event.data ?? [],
          });
        } else if (event.type === 'end') {
          updateMessage(messageId, {
            status: 'complete',
          });

          setIsPending(false);
        }
      }

      if (generation === activeStreamRef.current) {
        updateMessage(messageId, {
          status: 'complete',
        });

        setIsPending(false);
      }
    } catch (err) {
      if (generation !== activeStreamRef.current) return;

      updateMessage(messageId, {
        status: 'error',
        error: err.message || 'The query could not be answered. Please try again.',
      });

      setIsPending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div>
      <PipelineStages />

      <section className="chat-panel" aria-label="Chat interface">
        <form
          className="chat-form"
          onSubmit={handleSubmit}
          aria-label="Submit a question"
        >
          <label htmlFor="query-input" className="chat-label">
            Ask a question
          </label>

          <textarea
            id="query-input"
            className="chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your question and press Enter or click Ask…"
            rows={3}
            disabled={isPending}
            aria-label="Query input"
          />

          <button
            type="submit"
            className="chat-submit-btn"
            disabled={isPending || !inputText.trim()}
            aria-busy={isPending}
          >
            {isPending ? 'Generating…' : 'Ask'}
          </button>
        </form>

        {/* Persistent conversation history */}
        <div className="chat-history" aria-live="polite">
          {messages.map((message) => (
            <article className="chat-message" key={message.id}>
              {/* User question */}
              <div className="chat-query">
                <span className="chat-query-label">QUERY</span>
                <p>{message.query}</p>
              </div>

              {/* Loading indicator */}
              {message.status === 'pending' && (
                <div className="chat-pending" role="status">
                  <span className="chat-spinner" aria-hidden="true" />
                  <span>Generating answer…</span>
                </div>
              )}

              {/* Error message */}
              {message.status === 'error' && (
                <div className="chat-error" role="alert">
                  {message.error}
                </div>
              )}

              {/* Answer */}
              {(message.answer || message.status === 'complete') &&
                message.status !== 'error' && (
                  <section
                    className={`chat-answer ${
                      message.status === 'pending'
                        ? 'chat-answer--streaming'
                        : ''
                    }`}
                    aria-label="Answer"
                  >
                    <h2 className="chat-answer-heading">Answer</h2>

                    <div className="chat-answer-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.answer}
                      </ReactMarkdown>
                    </div>
                  </section>
                )}

              {/* Citations */}
              {message.status === 'complete' &&
                message.citations.length > 0 && (
                  <section className="chat-citations">
                    <h2 className="chat-section-heading">Sources</h2>
                    <CitationList citations={message.citations} />
                  </section>
                )}

              {/* Retrieved passages */}
              {message.status === 'complete' &&
                message.chunks.length > 0 && (
                  <section className="chat-chunks">
                    <RetrievedChunks chunks={message.chunks} />
                  </section>
                )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default GlobalChat;
