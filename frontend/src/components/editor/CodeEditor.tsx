import React from 'react';
import Editor, { OnChange } from '@monaco-editor/react';

export interface CodeEditorProps {
  value: string;
  language: string;
  readOnly: boolean;
  onChange?: (value: string | undefined) => void;
  height?: string | number;
  theme?: string;
  className?: string;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  value,
  language,
  readOnly,
  onChange,
  height = '420px',
  theme = 'vs-dark',
  className,
}) => {
  const handleChange: OnChange = (val) => {
    if (onChange) {
      onChange(val);
    }
  };

  return (
    <div
      className={className}
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      <Editor
        height={height}
        language={language}
        value={value}
        theme={theme}
        onChange={handleChange}
        options={{
          readOnly,
          domReadOnly: readOnly,
          minimap: { enabled: false },
          fontSize: 14,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
        }}
      />
    </div>
  );
};

export default CodeEditor;
