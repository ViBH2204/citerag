import React, { useState, useEffect, useRef } from 'react';
import MarkdownMessage from './components/MarkdownMessage';
import CitationList from './components/CitationList';
import RetrievedChunks from './components/RetrievedChunks';
import PipelineStages from './components/PipelineStages';
import ThemeSwitcher from './components/ThemeSwitcher';
import {
  queryConversationStream,
  createConversation,
  getGlobalDocuments,
  uploadGlobalFile,
  deleteGlobalDocument
} from './services/api';

// Use the available hardware concurrency to upload/index files in parallel,
// capped to a sensible ceiling so we don't overwhelm the backend.
const UPLOAD_CONCURRENCY = Math.max(
  2,
  Math.min((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, 6)
);

/**
 * Run async `worker(item)` over `items` with a bounded number of concurrent
 * workers. Returns once every item has been processed.
 */
async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

const pluralize = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * CiteRAG application.
 * Two-section layout: a PDF document library (upload, documents, ingestion
 * pipeline) on the left and a chat workspace (conversation, per-answer
 * sources, input) on the right.
 */
function App() {
  // --- Chat State ---
  const [inputText, setInputText] = useState('');
  const [messages, setMessages] = useState([]);
  const [isPending, setIsPending] = useState(false);
  const [conversationId, setConversationId] = useState(null);

  // --- Document Management State ---
  const [documents, setDocuments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState({ text: '', type: '' });
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });
  const [fileStatuses, setFileStatuses] = useState([]); // [{ name, status }]
  const [deletingDocs, setDeletingDocs] = useState(new Set());
  const [isDragOver, setIsDragOver] = useState(false);

  const activeStreamRef = useRef(0);
  const fileInputRef = useRef(null);

  // --- Chat scroll management ---
  // The conversation follows new content only while the user is already
  // near the bottom, so reading earlier answers is never interrupted.
  const threadRef = useRef(null);
  const stickToBottomRef = useRef(true);

  const handleThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // --- Ingestion pipeline timeline labelling ---
  // PipelineStages keeps its own markup, logic and state. This effect only
  // adds data-cr-role attributes to what it renders (list, stage, number,
  // title, description, connector) so the CSS can show it as a compact
  // vertical timeline and hide the separate arrow items. React does not
  // manage these attributes, so they survive re-renders; a MutationObserver
  // re-applies them if the component adds or replaces elements.
  const pipelineRef = useRef(null);

  useEffect(() => {
    const root = pipelineRef.current;
    if (!root || typeof MutationObserver === 'undefined') return undefined;

    const hasText = (el) => /[A-Za-z0-9]/.test(el.textContent || '');
    const setRole = (el, role) => {
      if (el.getAttribute('data-cr-role') !== role) el.setAttribute('data-cr-role', role);
    };

    const labelPipeline = () => {
      // Stage items are the list items; if the component does not use a
      // list, fall back to the children of its largest container.
      let items = Array.from(root.querySelectorAll('li'));
      if (items.length === 0) {
        let container = null;
        root.querySelectorAll('*').forEach((el) => {
          if (!container || el.children.length > container.children.length) container = el;
        });
        items = container && container.children.length >= 4 ? Array.from(container.children) : [];
      }
      if (items.length === 0) return;

      const list = items[0].parentElement;
      if (list && list !== root) setRole(list, 'list');

      items.forEach((item) => {
        // Arrow/connector items contain no letters or digits.
        if (!hasText(item)) {
          setRole(item, 'connector');
          return;
        }
        setRole(item, 'stage');

        const leaves = Array.from(item.querySelectorAll('*')).filter(
          (el) => el.children.length === 0 && hasText(el)
        );
        const num = leaves.find((el) => /^(step\s*)?\d{1,2}\.?$/i.test(el.textContent.trim()));
        const textLeaves = leaves.filter((el) => el !== num);

        if (num) {
          setRole(num, 'num');
          if (!item.hasAttribute('data-cr-numbered')) item.setAttribute('data-cr-numbered', '');
        }
        if (textLeaves[0]) setRole(textLeaves[0], 'title');
        if (textLeaves.length > 1) setRole(textLeaves[textLeaves.length - 1], 'desc');
      });
    };

    labelPipeline();
    const observer = new MutationObserver(labelPipeline);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  // --- Initialize Conversation and Fetch Documents ---
  useEffect(() => {
    // 1. Create conversation session
    createConversation()
      .then((data) => {
        setConversationId(data.conversation_id);
      })
      .catch((err) => {
        console.error('Failed to create conversation:', err);
      });

    // 2. Fetch already-ingested documents
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    try {
      const data = await getGlobalDocuments();
      setDocuments(data.documents || []);
    } catch (err) {
      console.error('Failed to fetch documents:', err);
    }
  };

  // --- Document Upload Handlers ---
  const handleFileUploads = async (selectedFiles) => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    const pdfFiles = selectedFiles.filter(file => file.name.toLowerCase().endsWith('.pdf'));
    const invalidFiles = selectedFiles.filter(file => !file.name.toLowerCase().endsWith('.pdf'));

    if (pdfFiles.length === 0) {
      showUploadMessage('Only PDF files are supported.', 'error');
      return;
    }

    setUploading(true);
    setUploadProgress({ done: 0, total: pdfFiles.length });
    setFileStatuses(pdfFiles.map(f => ({ name: f.name, status: 'queued' })));

    const successFiles = [];
    const failedFiles = [];
    let completed = 0;

    const updateStatus = (name, status) => {
      setFileStatuses(prev =>
        prev.map(fs => (fs.name === name ? { ...fs, status } : fs))
      );
    };

    // Upload and index files in parallel, bounded by the device's capacity.
    await runWithConcurrency(pdfFiles, UPLOAD_CONCURRENCY, async (file) => {
      updateStatus(file.name, 'uploading');
      try {
        const result = await uploadGlobalFile(file);
        if (result.success) {
          successFiles.push(file.name);
          updateStatus(file.name, 'done');
          fetchDocuments();
        } else {
          failedFiles.push(`${file.name} (failed to index)`);
          updateStatus(file.name, 'error');
        }
      } catch (err) {
        const errMsg = err.response?.data?.detail || err.message || 'unknown error';
        failedFiles.push(`${file.name} (${errMsg})`);
        updateStatus(file.name, 'error');
      } finally {
        completed += 1;
        setUploadProgress({ done: completed, total: pdfFiles.length });
      }
    });

    let messageText = '';
    let messageType = 'success';

    if (successFiles.length > 0) {
      messageText += `Indexed ${successFiles.length} file${successFiles.length !== 1 ? 's' : ''}. `;
    }
    if (failedFiles.length > 0) {
      messageText += `Failed: ${failedFiles.join(', ')}. `;
      messageType = successFiles.length > 0 ? 'info' : 'error';
    }
    if (invalidFiles.length > 0) {
      messageText += `Skipped non-PDF: ${invalidFiles.map(f => f.name).join(', ')}.`;
      if (messageType === 'success') messageType = 'info';
    }

    showUploadMessage(messageText.trim(), messageType);
    setUploading(false);
    setUploadProgress({ done: 0, total: 0 });
    // Clear the per-file status list shortly after completion.
    setTimeout(() => setFileStatuses([]), 4000);
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileUploads(Array.from(e.target.files));
    }
    // Allow selecting the same file(s) again later.
    e.target.value = '';
  };

  const openFilePicker = () => {
    if (!uploading && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleUploadKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openFilePicker();
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (uploading) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileUploads(Array.from(e.dataTransfer.files));
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDocumentDelete = async (filename) => {
    setDeletingDocs(prev => new Set([...prev, filename]));
    try {
      await deleteGlobalDocument(filename);
      fetchDocuments();
    } catch (err) {
      console.error('Failed to delete document:', err);
      alert(`Failed to delete document: ${err.message}`);
    } finally {
      setDeletingDocs(prev => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
    }
  };

  const showUploadMessage = (text, type) => {
    setUploadMessage({ text, type });
    if (type !== 'info') {
      setTimeout(() => {
        setUploadMessage({ text: '', type: '' });
      }, 5000);
    }
  };

  // --- Query Chat Handler ---
  const handleSubmit = async (e) => {
    e.preventDefault();

    const query = inputText.trim();

    if (!query || isPending) return;

    const convId = conversationId;

    if (!convId) {
      alert('Conversation is not ready. Please wait and try again.');
      return;
    }

    const generation = ++activeStreamRef.current;
    const messageId = generation;

    // Always bring the new question into view.
    stickToBottomRef.current = true;

    // Add a new question without deleting previous conversations.
    setMessages((prev) => [
      ...prev,
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

    // Clear the input immediately.
    setInputText('');
    setIsPending(true);

    const updateMessage = (updates) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId
            ? { ...message, ...updates }
            : message
        )
      );
    };

    try {
      let accAnswer = '';

      for await (const event of queryConversationStream(convId, query)) {
        if (generation !== activeStreamRef.current) return;

        if (event.type === 'token') {
          accAnswer += event.text;
          updateMessage({ answer: accAnswer });
        } else if (event.type === 'sources') {
          updateMessage({ citations: event.data ?? [] });
        } else if (event.type === 'chunks') {
          updateMessage({ chunks: event.data ?? [] });
        } else if (event.type === 'end') {
          updateMessage({ status: 'complete' });
          setIsPending(false);
        }
      }

      if (generation === activeStreamRef.current) {
        updateMessage({ status: 'complete' });
        setIsPending(false);
      }
    } catch (err) {
      if (generation !== activeStreamRef.current) return;

      updateMessage({
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
    <div className="container">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">CR</span>
            <div className="brand-text">
              <h1>CiteRAG</h1>
              <p>Unified Multi-Document QA Engine</p>
            </div>
          </div>
          <div className="header-controls">
            <ThemeSwitcher />
          </div>
        </div>
      </header>

      {/* Two-section layout: document library + chat workspace */}
      <div className="split-pane">

        {/* LEFT: PDF Document Library */}
        <aside className="sidebar" aria-label="Document library">
          <div className="sidebar-section">
            <h2>Document Corpus</h2>

            {/* Upload Box */}
            <div
              className={`drag-upload-box ${isDragOver ? 'dragover' : ''} ${uploading ? 'disabled' : ''}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={openFilePicker}
              onKeyDown={handleUploadKeyDown}
              role="button"
              tabIndex={uploading ? -1 : 0}
              aria-disabled={uploading}
              aria-label="Upload PDF files"
            >
              <input
                ref={fileInputRef}
                type="file"
                id="fileInput"
                style={{ display: 'none' }}
                accept=".pdf"
                multiple
                onChange={handleFileChange}
                disabled={uploading}
              />
              <svg className="upload-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
              </svg>
              <p>
                Drop PDFs here or <span className="upload-link">browse</span>
              </p>
              <span className="upload-limit">
                Bulk upload supported · indexed {UPLOAD_CONCURRENCY} at a time
              </span>
            </div>

            {/* Bulk upload progress */}
            {uploading && uploadProgress.total > 0 && (
              <div className="upload-progress" role="status" aria-live="polite">
                <div className="upload-progress-head">
                  <span>Indexing documents</span>
                  <span>{uploadProgress.done} / {uploadProgress.total}</span>
                </div>
                <div className="upload-progress-track">
                  <div
                    className="upload-progress-bar"
                    style={{ width: `${(uploadProgress.done / uploadProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Per-file status list */}
            {fileStatuses.length > 0 && (
              <ul className="upload-file-list">
                {fileStatuses.map((fs) => (
                  <li key={fs.name} className={`upload-file-item upload-file-item--${fs.status}`}>
                    <span className="upload-file-status-dot" aria-hidden="true" />
                    <span className="upload-file-name" title={fs.name}>{fs.name}</span>
                    <span className="upload-file-state">
                      {fs.status === 'queued' && 'Queued'}
                      {fs.status === 'uploading' && 'Indexing…'}
                      {fs.status === 'done' && 'Done'}
                      {fs.status === 'error' && 'Failed'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* Upload Message */}
            {uploadMessage.text && (
              <div className={`status-msg ${uploadMessage.type}`}>
                {uploadMessage.text}
              </div>
            )}
          </div>

          {/* Ingested Documents List */}
          <div className="sidebar-section documents-list-section">
            <div className="documents-list-head">
              <h3>Ingested Documents</h3>
              <span className="count-pill">{documents.length}</span>
            </div>
            {documents.length === 0 ? (
              <p className="no-docs-msg">No documents in the corpus yet. Upload a PDF above.</p>
            ) : (
              <div className="documents-list">
                {documents.map((doc, idx) => (
                  <div className="document-list-item" key={idx} title={doc.filename}>
                    <span className="document-icon" aria-hidden="true">PDF</span>
                    <div className="document-info">
                      <span className="document-name" title={doc.filename}>{doc.filename}</span>
                    </div>
                    <button
                      type="button"
                      className="document-delete-btn"
                      onClick={() => handleDocumentDelete(doc.filename)}
                      disabled={deletingDocs.has(doc.filename)}
                      aria-label={`Delete ${doc.filename}`}
                    >
                      {deletingDocs.has(doc.filename) ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Ingestion Pipeline — directly below the PDF list */}
          <div className="sidebar-section pipeline-section" ref={pipelineRef}>
            <PipelineStages />
          </div>
        </aside>

        {/* RIGHT: Chat Workspace */}
        <main className="chat-container-main">
          {/* Chat Panel */}
          <section className="chat-panel" aria-label="Chat interface">

            {/* Scrollable conversation */}
            <div
              className="chat-scroll"
              ref={threadRef}
              onScroll={handleThreadScroll}
            >
              {messages.length === 0 ? (
                <div className="welcome-chat-panel">
                  <h2>Ask your documents anything</h2>
                  <p>
                    Upload your PDF documents in the library on the left,
                    then type a question below to get answers grounded
                    in the corpus, with sources for every answer.
                  </p>
                </div>
              ) : (
                <div className="chat-thread">
                  {messages.map((message) => {
                    const citationCount = message.citations?.length || 0;
                    const chunkCount = message.chunks?.length || 0;
                    const hasSources = citationCount > 0 || chunkCount > 0;

                    return (
                      <article className="chat-message" key={message.id}>

                        {/* User Query */}
                        <div className="chat-query-row">
                          <div className="chat-query-bubble">
                            <span className="bubble-label">You</span>
                            <p>{message.query}</p>
                          </div>
                        </div>

                        {/* Answer + its own sources */}
                        <div className="chat-answer-row">
                          <span className="chat-answer-avatar" aria-hidden="true">CR</span>

                          <div className="chat-answer-column">
                            {/* Loading (before the first token arrives) */}
                            {message.status === 'pending' && !message.answer && (
                              <div className="chat-pending" role="status">
                                <span className="chat-spinner" aria-hidden="true" />
                                <span>Generating answer...</span>
                              </div>
                            )}

                            {/* Answer */}
                            {message.answer && (
                              <section
                                className={`chat-answer ${
                                  message.status === 'pending'
                                    ? 'chat-answer--streaming'
                                    : ''
                                }`}
                                aria-label="Answer"
                              >
                                <div className="chat-answer-head">
                                  <span className="chat-answer-heading">CiteRAG</span>
                                  {message.status === 'pending' && (
                                    <span className="chat-streaming-tag" role="status">
                                      <span className="chat-spinner chat-spinner--sm" aria-hidden="true" />
                                      Generating answer...
                                    </span>
                                  )}
                                </div>

                                <div className="chat-answer-body">
                                  <MarkdownMessage content={message.answer} />
                                </div>
                              </section>
                            )}

                            {/* Sources and retrieved passages, directly below this answer */}
                            {hasSources && (
                              <section className="message-sources" aria-label="Sources and retrieved passages">
                                <div className="message-sources-head">
                                  <span className="message-sources-title">Sources</span>
                                  <span className="message-sources-meta">
                                    {citationCount > 0 && pluralize(citationCount, 'reference')}
                                    {citationCount > 0 && chunkCount > 0 && ' · '}
                                    {chunkCount > 0 && pluralize(chunkCount, 'retrieved passage')}
                                  </span>
                                </div>

                                {citationCount > 0 && (
                                  <div className="message-source-citations">
                                    <h4>Referenced documents</h4>
                                    <CitationList citations={message.citations} />
                                  </div>
                                )}

                                {chunkCount > 0 && (
                                  <details className="message-source-passages">
                                    <summary>
                                      <span className="summary-chevron" aria-hidden="true" />
                                      Retrieved passages
                                      <span className="count-pill">{chunkCount}</span>
                                    </summary>
                                    <div className="message-source-passages-body">
                                      <RetrievedChunks chunks={message.chunks} />
                                    </div>
                                  </details>
                                )}
                              </section>
                            )}

                            {/* Error */}
                            {message.status === 'error' && (
                              <div className="chat-error" role="alert">
                                The query could not be answered. {message.error}
                              </div>
                            )}
                          </div>
                        </div>

                      </article>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Input Form — fixed at the bottom of the chat workspace */}
            <form className="chat-form" onSubmit={handleSubmit} aria-label="Submit a question">
              <div className="chat-input-box">
                <textarea
                  id="query-input"
                  className="chat-input"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask a question about your documents..."
                  rows={2}
                  disabled={isPending}
                  aria-label="Query input"
                />
                <div className="chat-input-footer">
                  <span className="chat-input-hint">
                    Enter to send · Shift + Enter for a new line
                  </span>
                  <button
                    type="submit"
                    className="chat-submit-btn"
                    disabled={isPending || !inputText.trim()}
                    aria-busy={isPending}
                  >
                    {isPending ? 'Generating...' : 'Ask'}
                  </button>
                </div>
              </div>
            </form>
          </section>
        </main>

      </div>
    </div>
  );
}

export default App;
