import * as vscode from 'vscode';

// Extended type declarations for VS Code Language Model API with tools support
declare module 'vscode' {
    // Note: Enums and interfaces like LanguageModelChatMessageRole, LanguageModelChatTool, etc.
    // are already part of the vscode.d.ts and proposed.d.ts if the API version is recent enough.
    // Duplicating them here might cause conflicts if they are already globally available
    // from the vscode type definitions.
    // However, if they are NOT available in the project's current vscode.d.ts,
    // then these declarations are necessary.
    // For safety in this subtask, we will include them as provided by the user.
    // If type conflicts arise during compilation, these might need adjustment.

    // User-provided enum, assuming it might be specific or an older version.
    // If vscode.LanguageModelChatMessageRole exists, prefer that.
    // For this subtask, we use the user's definition.
    export enum LanguageModelChatMessageRole {
        User = 1,
        Assistant = 2,
        // System = 0, // Often there's a system role too.
    }

    // User-provided enum
    export enum LanguageModelChatToolMode {
        Auto = 1,
        Required = 2,
        // None = 0, // Often a 'none' mode too.
    }

    export interface LanguageModelChatTool {
        name: string;
        description: string;
        parameters?: object; // JSON schema
    }

    export interface LanguageModelChatRequestOptions {
        modelOptions?: { [key: string]: any };
        tools?: LanguageModelChatTool[];
        toolMode?: LanguageModelChatToolMode;
        justification?: string;
    }

    // Assuming LanguageModelTextPart and LanguageModelToolCallPart might be specific
    // or extensions to existing types if those exist in vscode.d.ts.
    // If vscode.LanguageModelTextPart exists, it should be used.
    export class LanguageModelTextPart {
        constructor(public value: string) {}
    }

    export class LanguageModelToolCallPart {
        constructor(
            public callId: string, // Renamed from 'id' in user's example to match potential vscode.d.ts
            public name: string,
            public parameters: object // Renamed from 'input' in user's example
        ) {}
    }

    export interface LanguageModelChatMessage {
        role: LanguageModelChatMessageRole; // Uses the enum defined above
        content: string | (LanguageModelTextPart | LanguageModelToolCallPart)[];
    }

    export interface LanguageModelChatResponse {
        stream: AsyncIterable<LanguageModelTextPart | LanguageModelToolCallPart>;
    }

    export interface LanguageModelChat {
        readonly name: string;
        readonly id: string;
        readonly vendor: string;
        readonly family: string;
        readonly version:string; // Added from user's example. Standard API might not have all of these.

        sendRequest(
            messages: LanguageModelChatMessage[],
            options?: LanguageModelChatRequestOptions,
            token?: vscode.CancellationToken
        ): Thenable<LanguageModelChatResponse>;
    }

    namespace lm {
        function selectChatModels(selector?: { [key: string]: string }): Thenable<LanguageModelChat[]>;
    }
}

// Interface for internal representation of tool calls, matching user's example
interface ToolCall {
    id: string;
    name: string;
    parameters: object;
}

// Interface for internal representation of chat messages, matching user's example
interface ChatMessage {
    role: 'system' | 'user' | 'assistant'; // System role added for completeness
    content: string;
    tool_calls?: ToolCall[]; // Optional tool calls
}

export class VsCodeLmHandler {
    private client: vscode.LanguageModelChat | null = null;
    private cancellationToken: vscode.CancellationTokenSource | null = null;
    private initialized: boolean = false;

    constructor(private modelSelector: { [key: string]: string } = {}) {}

    public isInitialized(): boolean {
        return this.initialized && !!this.client;
    }

    async initialize(): Promise<void> {
        try {
            const models = await vscode.lm.selectChatModels(this.modelSelector);
            this.client = models?.[0] ?? null;
            if (!this.client) {
                this.initialized = false; // Explicitly set on failure
                // vscode.window.showErrorMessage('No matching language models found for Flexpilot Agent.');
                console.error('No matching language models found for selector:', this.modelSelector);
                throw new Error('No matching language models found');
            }
            this.initialized = true; // Set on success
            console.info(`Flexpilot Agent initialized with model: ${this.client.id} (Vendor: ${this.client.vendor}, Version: ${this.client.version}, Family: ${this.client.family})`);
        } catch (error) {
            this.initialized = false; // Explicitly set on failure
            // vscode.window.showErrorMessage(`Failed to initialize VS Code LM for Flexpilot Agent: ${error instanceof Error ? error.message : String(error)}`);
            console.error(`Failed to initialize VS Code LM: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to initialize VS Code LM: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Corrected createVscodeMessages to better handle string content vs tool_calls
    private createVscodeMessages_corrected(messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
        return messages.map(msg => {
            const vscodeRole = msg.role === 'user'
                ? vscode.LanguageModelChatMessageRole.User
                : vscode.LanguageModelChatMessageRole.Assistant; // Assuming system prompts are handled by prepending

            let contentValue: string | (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[];

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                contentValue = msg.tool_calls.map(toolCall =>
                    new vscode.LanguageModelToolCallPart( // Uses the declared class
                        toolCall.id,
                        toolCall.name,
                        toolCall.parameters
                    )
                );
            } else {
                contentValue = msg.content; // Simple string content
            }

            return {
                role: vscodeRole,
                content: contentValue
            };
        });
    }


    async *chat(
        messages: ChatMessage[],
        tools?: vscode.LanguageModelChatTool[],
        options: {
            toolMode?: vscode.LanguageModelChatToolMode;
            systemPrompt?: string;
        } = {}
    ): AsyncIterable<{ type: 'text' | 'tool_call'; content: string | ToolCall }> {
        if (!this.client) {
            throw new Error('Language model client not initialized');
        }

        const allVscodeMessages: vscode.LanguageModelChatMessage[] = [];
        if (options.systemPrompt) {
            // System prompts in VSCode LM API are typically the first message with User/Assistant role
            // or handled differently by models. Some models prefer system prompt as first User message.
            // For this generic handler, let's assume a system prompt is added as the first message.
            // The API itself doesn't have a dedicated 'system' role in LanguageModelChatMessage.
            // The common pattern is:
            // 1. User: System instructions
            // 2. Assistant: Okay
            // 3. User: Actual prompt
            // Or, some models just take the system prompt as part of the initial user message, or an option.
            // The user's `declare module` doesn't add a System role to `LanguageModelChatMessageRole`.
            // So, we will add it as the first message to the `messages` array before conversion.
             allVscodeMessages.push(...this.createVscodeMessages_corrected([{role: 'user', content: options.systemPrompt}, ...messages]));
        } else {
            allVscodeMessages.push(...this.createVscodeMessages_corrected(messages));
        }


        this.cancellationToken = new vscode.CancellationTokenSource();
        const requestOptions: vscode.LanguageModelChatRequestOptions = {
            tools, // from parameter
            toolMode: options.toolMode, // from parameter
            justification: 'Flexpilot Agent request' // Custom justification
        };

        try {
            const response = await this.client.sendRequest(
                allVscodeMessages,
                requestOptions,
                this.cancellationToken.token
            );

            for await (const chunk of response.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    yield { type: 'text', content: chunk.value };
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                    yield {
                        type: 'tool_call',
                        content: {
                            id: chunk.callId, // from declared class
                            name: chunk.name,    // from declared class
                            parameters: chunk.parameters // from declared class
                        }
                    };
                }
            }
        } finally {
            this.cancellationToken.dispose();
            this.cancellationToken = null;
        }
    }

    async complete(
        prompt: string,
        systemPrompt?: string,
        tools?: vscode.LanguageModelChatTool[] // from parameter
    ): Promise<{ text?: string; tool_calls?: ToolCall[] }> {
        let text = '';
        const tool_calls: ToolCall[] = [];

        // Use the systemPrompt in the options for the chat method
        for await (const chunk of this.chat(
            [{ role: 'user', content: prompt }],
            tools, // Pass tools to chat
            { systemPrompt } // Pass systemPrompt to chat options
        )) {
            if (chunk.type === 'text') {
                text += chunk.content;
            } else {
                // Ensure chunk.content is treated as ToolCall
                tool_calls.push(chunk.content as ToolCall);
            }
        }

        return {
            ...(text ? { text } : {}),
            ...(tool_calls.length > 0 ? { tool_calls } : {}) // Ensure it's > 0
        };
    }

    cancel(): void {
        this.cancellationToken?.cancel();
    }

    dispose(): void {
        this.cancel();
        // this.client = null; // Client is managed by VS Code, not for us to null out usually.
                           // Disposing cancellation token is the main action.
    }
}
