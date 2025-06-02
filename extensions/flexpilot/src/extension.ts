/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Flexpilot AI. All rights reserved.
 *  Licensed under the GPL-3.0 License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logger } from './logger';
import { registerDisposable, setExtensionContext } from './context';
import { WebviewViewProvider, WebviewView, ExtensionContext, window, Uri, WebviewOptions } from 'vscode';
import { checkUpdateAvailable, setContext } from './utilities';
import { registerCheckInternetConnectionCommand } from './commands/check-connection';
import { handleGitHubFileSystemProvider } from './fs-provider';
import { registerVfsInfoMessageCommand } from './commands/vfs-info-message';
import { registerEditorVariable, registerSelectionVariable, registerTerminalLastCommandVariable, registerTerminalSelectionVariable } from './variables';
import { registerGithubSignInCommand } from './commands/github-sign-in';
import { registerStatusIconMenuCommand } from './commands/status-icon-menu';
import { registerConfigureModelCommand } from './commands/configure-model';
import { registerUsagePreferencesCommand } from './commands/usage-preferences';
import { registerCommitMessageCommand } from './commands/commit-message';
import { registerShowDiagnosticsCommand } from './commands/show-diagnostics';
import { VsCodeLmHandler, ALL_TOOLS } from './flexpilotLlmHandler'; // Import ALL_TOOLS
import * as Diff from 'diff';

/**
 * Activates the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	await setContext('isLoaded', false);
	await setContext('isNetworkConnected', true);
	await setContext('isLoggedIn', false);

	// Check for updates when the extension is activated
	checkUpdateAvailable();

	// set the extension context to the global context
	setExtensionContext(context);

	// Register the logger with the context
	registerDisposable(logger);
	logger.info('Activating Flexpilot extension');

	// Register the Agent View Provider
	const agentViewProvider = new AgentViewProvider(context.extensionUri, context);
	registerDisposable(
		vscode.window.registerWebviewViewProvider('flexpilot.agentView', agentViewProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// Register the commands
	registerCheckInternetConnectionCommand();
	registerGithubSignInCommand();
	registerUsagePreferencesCommand();
	registerConfigureModelCommand();
	registerStatusIconMenuCommand();
	registerVfsInfoMessageCommand();
	registerCommitMessageCommand();
	registerShowDiagnosticsCommand();

	// Register the variables
	registerEditorVariable();
	registerSelectionVariable();
	registerTerminalLastCommandVariable();
	registerTerminalSelectionVariable();

	// Check the internet connection and activate
	vscode.commands.executeCommand('flexpilot.checkInternetConnection');

	// Check if the workspace is a GitHub workspace
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (
		process.platform === 'web' &&
		workspaceFolder &&
		workspaceFolder.uri.scheme === 'web-fs' &&
		workspaceFolder.uri.authority === 'github'
	) {
		// Handle the GitHub file system provider
		logger.info('Handling GitHub file system provider');
		await handleGitHubFileSystemProvider(workspaceFolder.uri);
	}

	// Show the chat panel
	vscode.commands.executeCommand('workbench.action.chat.open');
	logger.info('Flexpilot extension initial activation complete');

	// Set the extension as loaded
	await setContext('isLoaded', true);
}

class AgentViewProvider implements vscode.WebviewViewProvider {
	private readonly _extensionUri: vscode.Uri;
	private readonly _context: vscode.ExtensionContext;
	private lmHandler: VsCodeLmHandler;
	private activeModelId?: string; // Stores the ID of the currently selected language model

	// State for conversational context
	private lastUserPrompt: string | null = null;
	private lastAiResponse: string | null = null; // Stores the raw code suggested by AI, or text response
	private lastContextContent: string | null = null; // Stores the code context block associated with lastAiResponse
	private lastContextType: string | null = null;


	constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
		this._extensionUri = extensionUri;
		this._context = context; // Store context
		// Initialize activeModelId (e.g., from settings later, for now undefined or a default)
		// For this subtask, let's keep it undefined initially to see default selection logic.
		this.activeModelId = undefined;

		// Initialize LmHandler with activeModelId if available, otherwise a default selector
		const initialModelSelector = this.activeModelId ? { id: this.activeModelId } : { vendor: 'copilot' };
		logger.info(`Initializing VsCodeLmHandler with selector: ${JSON.stringify(initialModelSelector)}`);
		this.lmHandler = new VsCodeLmHandler(initialModelSelector);
		this.initializeLmHandler(true).catch(err => { // Pass a flag for initial setup
			logger.error('Initial LM Handler initialization failed:', err);
		});
	}

	private async initializeLmHandler(isInitialSetup: boolean = false): Promise<void> {
		try {
			await this.lmHandler.initialize();
			const modelName = this.lmHandler.isInitialized() ? this.lmHandler.getClient()?.name : 'N/A';
			logger.info(`VsCodeLmHandler initialized successfully. Model: ${modelName}`);
			if (this.lmHandler.isInitialized() && this.lmHandler.getClient() && isInitialSetup) {
				// If it's the initial setup and a model was successfully selected (e.g. by default selector)
				// update activeModelId with the actually selected model's ID.
				this.activeModelId = this.lmHandler.getClient()!.id;
				logger.info(`Initial activeModelId set to: ${this.activeModelId}`);
			}
			// Optionally notify webview if LM is ready, especially after a change
			// webviewView.webview.postMessage({ command: 'lmReady', modelId: this.activeModelId });
		} catch (error) {
			logger.error(`Failed to initialize VsCodeLmHandler: ${error instanceof Error ? error.message : String(error)}`);
			// Optionally notify webview about the failure
			// webviewView.webview.postMessage({ command: 'lmError', error: 'Failed to initialize Language Model.' });
		}
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_resolveContext: vscode.WebviewViewResolveContext, // Renamed as context is now a class member
		_token: vscode.CancellationToken,
	) {
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Add onDidDispose listener for lmHandler cleanup
		webviewView.onDidDispose(
			() => {
				this.lmHandler.dispose();
				logger.info('VsCodeLmHandler disposed for AgentViewProvider.');
			},
			null,
			this._context.subscriptions // Use the stored context's subscriptions
		);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'getAvailableModels': {
					logger.info('Webview requested available models.');
					try {
						// Passing an empty selector {} should get all models.
						// Note: `vscode.lm.selectChatModels` might return models the user doesn't have access to.
						// The `vscode.lm.chatModels` (proposed API) might be better for listing accessible models.
						// For now, using selectChatModels as per existing patterns if lm.chatModels isn't available/used.
						const allModels = await vscode.lm.selectChatModels({}); // Or use vscode.lm.chatModels if available & preferred
						logger.info(`Found ${allModels.length} potential models via selectChatModels.`);

						const processedModels = allModels.map(m => ({
							id: m.id,
							name: m.name || m.id, // Fallback to ID if name is not present
							vendor: m.vendor,
							family: m.family,
							version: m.version
						}));

						// If activeModelId is not set, and we found models, set a default.
						// Prefer a copilot model if available as a heuristic default.
						if (!this.activeModelId && processedModels.length > 0) {
							const copilotModel = processedModels.find(m => m.id.includes('copilot'));
							if (copilotModel) {
								this.activeModelId = copilotModel.id;
								logger.info(`Default activeModelId set to Copilot model: ${this.activeModelId}`);
							} else {
								this.activeModelId = processedModels[0].id; // Fallback to the first model
								logger.info(`Default activeModelId set to first available model: ${this.activeModelId}`);
							}
						}

						webviewView.webview.postMessage({
							command: 'availableModelsReceived',
							models: processedModels,
							activeModelId: this.activeModelId
						});
					} catch (error: any) {
						logger.error('Failed to get available models:', error);
						webviewView.webview.postMessage({
							command: 'availableModelsReceived',
							models: [],
							error: `Failed to fetch models: ${error.message || String(error)}`
						});
					}
					break;
				}
				case 'setSelectedModel': {
					const modelId = message.modelId as string;
					logger.info(`Webview requested to set model to: ${modelId}`);
					if (this.activeModelId === modelId && this.lmHandler.isInitialized()) {
						logger.info(`Model ${modelId} is already active and initialized. No change needed.`);
						// Optionally, send a confirmation back if webview expects it
						// webviewView.webview.postMessage({ command: 'modelChangeConfirmed', modelId: modelId });
						return;
					}

					this.activeModelId = modelId;
					logger.info(`Active model ID updated to: ${this.activeModelId}`);

					// Re-initialize LmHandler with the new model ID
					if (this.lmHandler) {
						this.lmHandler.dispose(); // Dispose of the old handler first
					}

					logger.info(`Re-initializing VsCodeLmHandler with new model ID: ${this.activeModelId}`);
					this.lmHandler = new VsCodeLmHandler({ id: this.activeModelId }); // Use specific ID selector
					try {
						await this.initializeLmHandler();
						logger.info(`Successfully re-initialized VsCodeLmHandler with model: ${this.activeModelId}`);
						// Confirmation can be sent if needed, but webview already shows a local message.
						// webviewView.webview.postMessage({ command: 'modelChangeConfirmed', modelId: this.activeModelId });
					} catch (error) {
						logger.error(`Failed to re-initialize VsCodeLmHandler with model ${this.activeModelId}:`, error);
						// Notify webview of the error
						webviewView.webview.postMessage({
							command: 'llmResponseReceived', // Reuse for general messages/errors
							llmResponse: `Error: Failed to switch to model ${modelId}. Please try again or select another model.`
						});
					}
					break;
				}
				case 'getActiveFileContext': {
					const editor = vscode.window.activeTextEditor;
					// Reset conversation history when new context is explicitly loaded
					this.lastUserPrompt = null;
					this.lastAiResponse = null;
					this.lastContextContent = null;
					this.lastContextType = null;
					logger.info('Context updated (ActiveFile), conversation history reset.');

					if (editor) {
						const content = editor.document.getText();
						webviewView.webview.postMessage({
							command: 'contextReceived',
							type: 'ActiveFile',
							content: content || 'Active file is empty.',
						});
					} else {
						webviewView.webview.postMessage({
							command: 'contextReceived',
							type: 'ActiveFile',
							content: 'No active text editor found.',
						});
					}
					break;
				}
				case 'getSelectionContext': {
					const editor = vscode.window.activeTextEditor;
					// Reset conversation history when new context is explicitly loaded
					this.lastUserPrompt = null;
					this.lastAiResponse = null;
					this.lastContextContent = null;
					this.lastContextType = null;
					logger.info('Context updated (Selection), conversation history reset.');

					if (editor) {
						const selection = editor.selection;
						const selectedText = editor.document.getText(selection);
						if (selectedText) {
							webviewView.webview.postMessage({
								command: 'contextReceived',
								type: 'Selection',
								content: selectedText,
							});
						} else {
							webviewView.webview.postMessage({
								command: 'contextReceived',
								type: 'Selection',
								content: 'No text selected or selection is empty.',
							});
						}
					} else {
						webviewView.webview.postMessage({
							command: 'contextReceived',
							type: 'Selection',
							content: 'No active text editor found.',
						});
					}
					break;
				}
				case 'applyChanges': {
					// Applying changes should ideally not affect the conversational history for follow-ups,
					// unless the nature of "apply" implies the end of that micro-conversation.
					// For now, we don't reset lastUserPrompt etc. here.
					const modifiedContent = message.modifiedContent as string;
					const contextType = message.contextType as string;
					const selectionDetails = message.selectionDetails as { startLine: number, startCharacter: number, endLine: number, endCharacter: number } | null;

					const editor = vscode.window.activeTextEditor;
					if (!editor) {
						logger.warn('No active text editor to apply changes to.');
						webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: 'Error: No active text editor found.' });
						return;
					}

					try {
						await editor.edit(editBuilder => {
							if (contextType === 'Selection' && selectionDetails) {
								const selectionRange = new vscode.Range(
									new vscode.Position(selectionDetails.startLine, selectionDetails.startCharacter),
									new vscode.Position(selectionDetails.endLine, selectionDetails.endCharacter)
								);
								// Basic check if the current editor's selection still matches the recorded one.
								// For a more robust solution, consider versioning or more advanced diff-patching if the document changed significantly.
								if (!editor.selection.isEqual(selectionRange)) {
									// If selection has changed, one might opt to still apply to the original range,
									// or abort. Aborting is safer if the context for the change is now invalid.
									logger.warn('Selection changed since suggestion was made. Applying to original range.');
									// Or throw: throw new Error('Editor selection has changed. Please request a new suggestion.');
								}
								editBuilder.replace(selectionRange, modifiedContent);

							} else if (contextType === 'ActiveFile') {
								const document = editor.document;
								const fullRange = new vscode.Range(
									document.positionAt(0),
									document.positionAt(document.getText().length)
								);
								editBuilder.replace(fullRange, modifiedContent);
							} else {
								throw new Error('Invalid context type for applying changes.');
							}
						});

						logger.info('Changes applied successfully.');
						webviewView.webview.postMessage({ command: 'changesAppliedSuccessfully' });

					} catch (error: any) {
						logger.error('Error applying changes:', error);
						webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: `Error applying changes: ${error.message || String(error)}` });
					}
					break;
				}
				case 'discardChanges':
					logger.info('User discarded AI suggestion.');
					// No specific action needed in the extension for discard,
					// as the webview clears its own state. Webview already updated its UI.
					// Optionally, send an acknowledgement if truly needed:
					// webviewView.webview.postMessage({ command: 'changesDiscardedAcknowledged' });
					break;
				case 'resetChatState':
					logger.info('Resetting chat state in AgentViewProvider.');
					this.lastUserPrompt = null;
					this.lastAiResponse = null;
					this.lastContextContent = null;
					this.lastContextType = null;
					// No response to webview needed as it handles its UI reset locally.
					break;
				case 'sendPromptToLLM': {
					const userRequest = message.prompt as string;
					// contextType and contextContent from the message are the *newly loaded* explicit context for this turn.
					const currentTurnContextType = message.contextType as string;
					const currentTurnContextContent = message.contextContent as string;

					logger.info(`Received sendPromptToLLM: "${userRequest}". Current turn context type: ${currentTurnContextType || 'None'}`);

					if (!this.lmHandler || !this.lmHandler.isInitialized()) {
						const notReadyMsg = 'Language Model is not ready. Please try again shortly.';
						logger.warn(notReadyMsg);
						this.lastUserPrompt = userRequest; // Store user prompt even if LM is not ready
						this.lastContextContent = currentTurnContextContent;
						this.lastContextType = currentTurnContextType;
						this.lastAiResponse = null; // No AI response
						webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: notReadyMsg });
						return;
					}

					const systemPrompt = `You are an AI assistant. If the user provides code, and their request implies code modification, provide only the complete modified code block as your response. Do not include explanations outside of code comments unless specifically asked. If the request is for explanation or general query, provide a concise textual answer.`;

					let promptForLlm = "";

					// Construct conversational history if available
					if (this.lastUserPrompt && this.lastAiResponse) {
						promptForLlm += `Previous user query: "${this.lastUserPrompt}"\n`;
						if (this.lastContextType && this.lastContextContent) {
							promptForLlm += `Previous code context (${this.lastContextType}):\n\`\`\`\n${this.lastContextContent}\n\`\`\`\n`;
						}
						promptForLlm += `Previous AI response:\n\`\`\`\n${this.lastAiResponse}\n\`\`\`\n\n`;
						promptForLlm += `Current user query (follow-up): "${userRequest}"\n`;
					} else {
						promptForLlm += `User query: "${userRequest}"\n`;
					}

					let currentLanguageId = 'plaintext';
					if (currentTurnContextType) { // Only if new context is explicitly provided for THIS turn
						const editor = vscode.window.activeTextEditor; // Needed for language ID
						if (editor && currentTurnContextType === 'ActiveFile') {
							currentLanguageId = editor.document.languageId;
						}
						promptForLlm += `\nConsider the following code block (${currentTurnContextType}, language: ${currentLanguageId}):\n\`\`\`${currentLanguageId}\n${currentTurnContextContent}\n\`\`\`\n`;
					} else if (!this.lastContextContent && !currentTurnContextContent) { // No previous context and no current context
						promptForLlm += `\n(No specific code context provided for this query.)\n`;
					}

					promptForLlm += `\nResponse:`;

					// Update state for the *next* potential follow-up BEFORE the call
					this.lastUserPrompt = userRequest;
					this.lastContextContent = currentTurnContextContent; // This becomes the context for the AI's response
					this.lastContextType = currentTurnContextType;
					// this.lastAiResponse will be updated upon receiving the response

					try {
						logger.info('Sending request to VsCodeLmHandler.complete with constructed prompt and ALL_TOOLS.');
						// Pass ALL_TOOLS to the complete method
						const llmResult = await this.lmHandler.complete(promptForLlm, systemPrompt, ALL_TOOLS);

						// Handle tool results first if any
						if (llmResult.tool_results && llmResult.tool_results.length > 0) {
							logger.info(`LLM executed tools. Results: ${JSON.stringify(llmResult.tool_results)}`);
							this.lastAiResponse = JSON.stringify(llmResult.tool_results); // Store raw tool results as last AI response for context

							for (const toolResult of llmResult.tool_results) {
								const resultMsg = toolResult.result.success
									? `Tool '${toolResult.callId}' executed successfully: ${toolResult.result.message || 'No message.'}`
									: `Tool '${toolResult.callId}' failed: ${toolResult.result.error || 'No error details.'}`;

								logger.info(`Tool execution result for ${toolResult.callId}: ${resultMsg}`);
								webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: `[Tool Result] ${resultMsg}` });
							}
							// If there was also text, handle it after tool results.
							// For now, assuming if tools are called, their results are the primary response for this turn.
							// If both text and tool_results can meaningfully coexist for the webview, this logic might need adjustment.
						}

						if (llmResult.text && llmResult.text.trim() !== '') {
							// If there were tool results, this text might be a summary or follow-up.
							// If not, it's the primary response.
							const aiTextResponse = llmResult.text;
							this.lastAiResponse = aiTextResponse; // Update last AI response if text is primary
							logger.info('LLM .text response received from VsCodeLmHandler.');

							// Diff logic (remains the same, operates on aiTextResponse)
							logger.info('LLM .text response received from VsCodeLmHandler.');

							// Diff is only relevant if the AI's response is meant to modify the currentTurnContextContent
							// And currentTurnContextContent was actually provided.
							if (currentTurnContextContent && llmResult.text !== currentTurnContextContent) {
								const patchFileName = currentTurnContextType === 'ActiveFile' ? vscode.window.activeTextEditor?.document.fileName || 'file.txt' : 'selection.txt';
								const patch = Diff.createPatch(
									patchFileName,
									currentTurnContextContent, // Old string is the current turn's context
									llmResult.text,           // New string is the AI's response
									'Original',
									'AI Suggestion'
								);

								let selectionDetails = null;
								if (currentTurnContextType === 'Selection' && vscode.window.activeTextEditor) {
									const selection = vscode.window.activeTextEditor.selection;
									selectionDetails = {
										startLine: selection.start.line,
										startCharacter: selection.start.character,
										endLine: selection.end.line,
										endCharacter: selection.end.character
									};
								}
								// Send diff if currentTurnContextContent was provided and AI modified it
								webviewView.webview.postMessage({
									command: 'diffSuggestionReceived',
									originalContent: currentTurnContextContent, // The content that was diffed
									modifiedContent: llmResult.text,
									diffPatch: patch,
									contextType: currentTurnContextType,
									selectionDetails: selectionDetails
								});
							} else {
								// If no currentTurnContextContent or AI response is identical, or AI response is not code-like, send as plain text
								webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: llmResult.text });
							}
						} else if (llmResult.tool_calls && llmResult.tool_calls.length > 0) {
							this.lastAiResponse = JSON.stringify(llmResult.tool_calls);
							const toolCallInfo = `LLM requested tool calls: ${JSON.stringify(llmResult.tool_calls)}. These were executed and results logged.`;
							logger.info(toolCallInfo);
							// Display tool call requests only if no other response is sent.
							// Typically, the tool_results would be shown instead of the raw request.
							// If llmResult.text is also present, that will be shown.
							// This message is more for debugging or if only tool calls are returned without immediate text.
							if (!llmResult.text && (!llmResult.tool_results || llmResult.tool_results.length === 0)) {
								webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: toolCallInfo });
							}
						} else if (!llmResult.text && (!llmResult.tool_results || llmResult.tool_results.length === 0)) {
							// This case means no text, no tool_calls, and no tool_results.
							this.lastAiResponse = null; // No valid response to store
							const errorMsg = 'LLM returned an empty response (no text, no tool calls/results).';
							logger.warn(errorMsg + ' via VsCodeLmHandler.');
							webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: errorMsg });
						}
						// If only tool_results were present, a message for them has already been sent.
						// If only text was present, it's handled by the diff logic or direct llmResponseReceived.
						// If both, tool_results message sent, then text is handled.
						// If only tool_calls were requested (and no results processed yet, which shouldn't happen with current complete() logic),
						// a message about requested tool_calls is sent.

					} catch (error: any) {
						this.lastAiResponse = null; // Clear on error
						logger.error('Error calling lmHandler.complete:', error);
						webviewView.webview.postMessage({ command: 'llmResponseReceived', llmResponse: `Error from Language Model: ${error.message || String(error)}` });
					}
					break;
				}
			}
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = getNonce();

		// Generate URIs for diff2html assets
		const diff2htmlJsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'diff2html', 'dist', 'diff2html.min.js')
		);
		const diff2htmlCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'diff2html', 'dist', 'diff2html.min.css')
		);
		const highlightJsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'highlight.js', 'highlight.min.js')
		);
		const highlightCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'highlight.js', 'styles', 'default.min.css')
		);

		// CSP: Allow styles from diff2html.min.css and scripts from diff2html.min.js
		// The 'unsafe-inline' for style-src is for the <style> block, if that's acceptable.
		// If not, all styles would need to be in external files or specific nonces for style elements.
		// For script-src, we add the diff2htmlJsUri's source (which asWebviewUri makes `vscode-resource:`)
		// and also keep the nonce for our inline script.
		// However, asWebviewUri already makes the resource trusted for default CSP.
		// Let's adjust CSP to be more robust for vscode-resource scheme.
		// style-src 'self' ${webview.cspSource} 'unsafe-inline'; script-src 'self' 'nonce-${nonce}' ${webview.cspSource};
		// Default-src 'none' is good. Img-src is fine.
		// The key is that ${webview.cspSource} covers vscode-resource: origins.

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="
					default-src 'none';
					style-src ${webview.cspSource} 'unsafe-inline';
					script-src 'nonce-${nonce}' ${webview.cspSource};
					img-src ${webview.cspSource} https:;
				">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Flexpilot Agent</title>
				<link rel="stylesheet" type="text/css" href="${diff2htmlCssUri}">
				<link rel="stylesheet" type="text/css" href="${highlightCssUri}">
				<script src="${diff2htmlJsUri}"></script>
				<script src="${highlightJsUri}"></script>
				<style>
					/* Model Selector Styles */
					#model-selector-container {
						padding: 0px 10px 12px 10px; /* Adjusted padding */
						margin-bottom: 8px;
						border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-contrastBorder));
					}
					#model-selector-container label {
						display: block; /* Ensures label is on its own line */
						margin-bottom: 6px; /* Space between label and select */
						font-size: var(--vscode-font-size);
						color: var(--vscode-input-placeholderForeground); /* Use a standard color for labels */
						font-weight: bold;
					}
					#model-selector {
						width: 100%;
						padding: 6px 8px;
						border-radius: var(--vscode-input-borderRadius, 4px);
						border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder));
						background-color: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						font-family: var(--vscode-font-family);
						font-size: var(--vscode-font-size);
						height: 32px; /* Explicit height for better alignment */
						box-sizing: border-box; /* Include padding and border in the element's total width and height */
					}
					#model-selector:focus {
						outline: none;
						border-color: var(--vscode-focusBorder);
						box-shadow: 0 0 0 1px var(--vscode-focusBorder); /* Standard focus indicator */
					}
					#model-selector option {
						background-color: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
					}
					/* End Model Selector Styles */

					body, html {
						height: 100%;
						margin: 0;
						padding: 0;
						display: flex;
						flex-direction: column;
						font-family: var(--vscode-font-family);
						color: var(--vscode-editor-foreground);
						background-color: var(--vscode-sideBar-background);
						line-height: 1.5; /* Improved default line height */
					}

					/* Action Bar */
					.action-bar-container {
						display: flex;
						flex-wrap: wrap;
						align-items: center;
						padding: 6px 10px;
						border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-contrastBorder));
						margin-bottom: 8px;
					}
					.action-bar-container .button-group {
						display: flex;
						flex-wrap: wrap;
						gap: 8px;
						width: 100%; /* Allow group to manage button spacing/wrapping */
					}
					.action-bar-container .button-group button { /* Buttons in action bar */
						flex-grow: 0; /* Don't grow, take natural width */
						padding: 4px 10px; /* Slightly smaller padding for action bar buttons */
					}

					/* Prompt Input Area */
					.prompt-controls-container {
						padding: 0 10px 8px 10px;
						margin-bottom: 8px;
						border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-contrastBorder));
					}
					#prompt-input {
						width: 100%;
						box-sizing: border-box;
						padding: 8px 10px;
						border-radius: var(--vscode-input-borderRadius, 4px); /* Consistent radius */
						border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder));
						background-color: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						font-family: var(--vscode-font-family);
						font-size: var(--vscode-font-size);
						resize: vertical;
						min-height: 50px;
						line-height: 1.4; /* Specific line-height for textarea */
					}
					#prompt-input:focus {
						outline: none;
						border-color: var(--vscode-focusBorder);
						box-shadow: 0 0 0 1px var(--vscode-focusBorder);
					}
					.prompt-button-group { /* For Send/Stop buttons */
						margin-top: 8px;
						display: flex;
						gap: 8px;
					}
					.prompt-button-group button { /* Send/Stop buttons */
						flex-grow: 1;
						padding: 8px 12px; /* Standard padding for these main action buttons */
					}
					.prompt-button-group button#sendPromptBtn {
						background-color: var(--vscode-button-primaryBackground, var(--vscode-button-background));
						color: var(--vscode-button-primaryForeground, var(--vscode-button-foreground));
					}
					.prompt-button-group button#sendPromptBtn:hover {
						background-color: var(--vscode-button-primaryHoverBackground, var(--vscode-button-hoverBackground));
					}
					/* General disabled state for top-level buttons if not covered by .button-group button:disabled */
					.prompt-button-group button:disabled {
						background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
						color: var(--vscode-disabledForeground, var(--vscode-button-secondaryForeground));
						cursor: not-allowed;
						opacity: 0.7;
					}


					/* Chat Response Area */
					#response-area {
						flex-grow: 1;
						margin: 0 10px 10px 10px;
						padding: 10px;
						overflow-y: auto;
						background-color: var(--vscode-editor-background);
						border-radius: var(--vscode-input-borderRadius, 4px); /* Consistent radius */
						display: flex;
						flex-direction: column;
					}

					/* Context Indicator Area */
					.context-indicator {
						padding: 6px 10px; /* Adjusted padding */
						font-size: 0.9em; /* Adjusted font size */
						color: var(--vscode-descriptionForeground);
						background-color: var(--vscode-input-background);
						border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-contrastBorder));
						margin: 0 0 8px 0; /* Margin only at bottom, to separate from prompt-input if it's first */
						border-radius: var(--vscode-input-borderRadius, 4px); /* Consistent radius */
						display: flex;
						align-items: center;
						justify-content: space-between;
					}
					#context-text-element {
						flex-grow: 1;
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
					}
					.context-indicator strong { /* "Context:" label */
						color: var(--vscode-editorInfo-foreground, var(--vscode-foreground)); /* Slightly more prominent */
						margin-right: 4px;
					}
					.context-indicator span span {
						cursor: default;
					}
					.clear-context-button {
						background: none;
						border: none;
						color: var(--vscode-icon-foreground, var(--vscode-foreground));
						cursor: pointer;
						padding: 0 3px 0 6px;
						margin-left: 8px; /* More space from text */
						font-size: 1.2em;
						line-height: 1;
						vertical-align: middle;
					}
					.clear-context-button:hover {
						color: var(--vscode-errorForeground);
					}

					/* General Chat Message Styling */
					.chat-message {
						padding: 10px 14px; /* Adjusted padding */
						margin-bottom: 12px; /* Increased margin */
						border-radius: var(--vscode-input-borderRadius, 6px); /* Consistent with input fields */
						overflow-wrap: break-word;
						border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder));
						max-width: 95%;
						box-shadow: 0 1px 3px var(--vscode-scrollbarSlider-background); /* Slightly enhanced shadow */
						line-height: 1.45; /* Improved line height within messages */
					}
					.chat-message p:first-child { /* Target the <p> containing the strong label */
						margin-top: 0;
						margin-bottom: 6px; /* Space after label paragraph */
					}
					.chat-message p:first-child strong { /* "You:", "AI:" labels */
						font-weight: bold;
						display: inline; /* Keep label inline if not much other text in the <p> */
						margin-right: 6px;
					}

					/* User Prompt Styling */
					.user-prompt {
						background-color: var(--vscode-input-background);
						border-color: var(--vscode-focusBorder);
						align-self: flex-start;
						max-width: 85%;
					}
					.user-prompt p strong {
						color: var(--vscode-terminal-ansiBlue, var(--vscode-focusBorder)); /* Example: use a common accent color */
					}

					/* AI Message Styling */
					.ai-suggestion, .ai-response, .ai-status {
						background-color: var(--vscode-editorHoverWidget-background, var(--vscode-editorGroupHeader-tabsBackground));
						border-color: var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
						align-self: flex-start;
					}
					.ai-suggestion p strong, .ai-response p strong, .ai-status p strong {
						color: var(--vscode-terminal-ansiGreen, var(--vscode-gitDecoration-modifiedResourceForeground));  /* Example: use a common accent color */
					}
					.ai-status p strong { /* Specifically for "AI: Thinking..." */
						color: var(--vscode-terminal-ansiYellow, var(--vscode-descriptionForeground));
					}

					/* System Message Styling */
					.system-message {
						font-style: italic;
						color: var(--vscode-descriptionForeground);
						text-align: center;
						background-color: transparent;
						border: none;
						font-size: 0.9em;
						padding: 6px 0; /* Adjusted padding */
						max-width: 100%;
						box-shadow: none;
					}

					/* Diff Container Styling */
					.d2h-file-header {
						display: none !important;
					}
					.diff-container {
						margin-top: 10px; /* Increased space */
						border: 1px solid var(--vscode-editorWidget-border, var(--vscode-input-border)); /* Consistent border */
						border-radius: var(--vscode-input-borderRadius, 4px);
						background-color: var(--vscode-editor-background);
					}
					.d2h-wrapper .d2h-code-line {
						font-family: var(--vscode-editor-font-family) !important; /* Ensure override */
						font-size: var(--vscode-editor-font-size) !important; /* Ensure override */
						line-height: 1.4 !important; /* Consistent line height in diff */
					}
					.d2h-wrapper .d2h-code-side-linenumber, .d2h-wrapper .d2h-code-line-prefix {
						font-family: var(--vscode-editor-font-family) !important;
						font-size: var(--vscode-editor-font-size) !important;
					}
					.d2h-wrapper .d2h-code-line-ctn {
						overflow-wrap: anywhere;
					}
					/* More specific diff2html overrides for better theme integration */
					.d2h-code-line-prefix, .d2h-code-side-linenumber { color: var(--vscode-editorLineNumber-foreground); }
					.d2h-code-line-ctn      { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
					.d2h-code-side-line    { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
					.d2h-emptyplaceholder    { background-color: var(--vscode-editorGutter-background); }
					.d2h-file-diff         { border-color: var(--vscode-panel-border); }
					.d2h-files-diff        { border-color: var(--vscode-panel-border); }
					.d2h-diff-table        { font-family: var(--vscode-editor-font-family); }
					.line-num1, .line-num2  { color: var(--vscode-editorLineNumber-foreground); }
					.d2h-ins               { background-color: var(--vscode-editorGutter-addedBackground); }
					.d2h-del               { background-color: var(--vscode-editorGutter-deletedBackground); }


					/* Chat Button Styling (Apply/Discard/Copy inside AI suggestions) */
					.ai-suggestion .button-group { /* Target button group specifically in suggestions */
						margin-top: 10px;
						display: flex;
						gap: 8px; /* Spacing for Apply/Discard/Copy */
					}
					.ai-suggestion .chat-button {
						padding: 5px 10px;
						border: 1px solid var(--vscode-button-border, var(--vscode-input-border));
						background-color: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						cursor: pointer;
						border-radius: var(--vscode-input-borderRadius, 4px);
						flex-grow: 0; /* Buttons take natural width */
					}
					.ai-suggestion .chat-button:hover {
						background-color: var(--vscode-button-hoverBackground);
					}
					.ai-suggestion .chat-button:disabled {
						background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background-disabled));
						color: var(--vscode-disabledForeground, var(--vscode-button-foreground-disabled));
						cursor: not-allowed;
						opacity: 0.7;
					}

					/* General button styling for top-level buttons (Action Bar, Prompt Send) */
					/* This is now handled by .action-bar-container .button-group button and .prompt-button-group button */

					/* Preformatted text blocks (for user prompt text and AI textual responses) */
					.chat-message pre {
						white-space: pre-wrap;
						word-wrap: break-word;
						overflow-wrap: break-word;
						background-color: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
						padding: 10px; /* Increased padding */
						border-radius: var(--vscode-input-borderRadius, 4px); /* Consistent radius */
						border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder));
						display: block;
						overflow-x: auto;
						margin-top: 8px; /* Increased margin */
						line-height: 1.4; /* Consistent line height */
					}
				</style>
			</head>
			<body>
				<div id="context-display-area" class="context-indicator">
					<span id="context-text-element">No active context.</span>
					<button id="clear-context-btn" class="clear-context-button" style="display:none;" title="Clear Context">✖</button>
				</div>

				<div id="model-selector-container">
					<label for="model-selector">Select Model:</label>
					<select id="model-selector" name="model-selector">
						<option value="">Loading models...</option>
					</select>
				</div>

				<textarea id="prompt-input" placeholder="Send a message to Flexpilot Agent..." rows="3"></textarea>
				<div class="button-group"> {/* Main button group */}
					<button id="getActiveFileBtn">Use Active File Context</button>
					<button id="getSelectionBtn">Use Selection Context</button>
					<button id="clearChatBtn">Clear Chat</button>
					<button id="sendPromptBtn">Send to AI</button> {/* sendPromptBtn restored here */}
				</div>
				<div id="response-area">
					<!-- Chat messages will be appended here -->
				</div>
				<script nonce="${nonce}">
					const vscode = acquireVsCodeApi();
					const responseArea = document.getElementById('response-area');
					const promptInput = document.getElementById('prompt-input');
					const contextDisplayArea = document.getElementById('context-display-area'); // This is the parent div
					const contextTextElement = document.getElementById('context-text-element'); // The span for text
					const clearContextBtn = document.getElementById('clear-context-btn'); // The clear button
					const sendBtn = document.getElementById('sendPromptBtn');
					const clearChatBtn = document.getElementById('clearChatBtn');
					const modelSelector = document.getElementById('model-selector');

					let currentContext = { type: '', content: '' };
					let currentSuggestion = { modifiedContent: '', contextType: '', selectionDetails: null };

					// Initial state for send button & model selector
					sendBtn.disabled = true;
					modelSelector.disabled = true; // Disable until models are loaded

					promptInput.addEventListener('input', () => {
						sendBtn.disabled = promptInput.value.trim() === '';
					});

					// Request available models when the script loads
					console.log("Requesting available models...");
					vscode.postMessage({ command: 'getAvailableModels' });

					modelSelector.addEventListener('change', () => {
						const selectedModelId = modelSelector.value;
						console.log(`Model selection changed to: ${selectedModelId}`);
						if (selectedModelId) {
							vscode.postMessage({ command: 'setSelectedModel', modelId: selectedModelId });
							// Optionally, add a system message to responseArea confirming selection
							const confirmMsgDiv = document.createElement('div');
							confirmMsgDiv.className = 'chat-message system-message';
							confirmMsgDiv.innerHTML = `<p>Model set to: ${modelSelector.options[modelSelector.selectedIndex].text}</p>`;
							responseArea.appendChild(confirmMsgDiv);
							responseArea.scrollTop = responseArea.scrollHeight;
						}
					});

					function escapeHtml(unsafe: string) {
						if (typeof unsafe !== 'string') {
							return '';
						}
						return unsafe
							 .replace(/&/g, "&amp;")
							 .replace(/</g, "&lt;")
							 .replace(/>/g, "&gt;")
							 .replace(/"/g, "&quot;")
							 .replace(/'/g, "&#039;");
					}

					function removeLastAiStatusMessage() {
						const lastMessage = responseArea.lastElementChild;
						if (lastMessage && lastMessage.classList.contains('ai-status')) {
							responseArea.removeChild(lastMessage);
						}
					}

					function updateActiveContextDisplay(contextType, contextContent) {
						let contextInfoHtml = 'No active context.';
						// const contextTextElement = document.getElementById('context-text-element'); // Already defined globally
						// const clearContextBtn = document.getElementById('clear-context-btn'); // Already defined globally

						if (contextType && contextContent) {
							let contextName = contextType;
							let shortContent = contextContent.substring(0, 70);
							if (contextContent.length > 70) shortContent += '...';

							if (contextType === 'ActiveFile') {
								contextName = 'Active File';
							} else if (contextType === 'Selection') {
								contextName = 'Current Selection';
							}
							contextInfoHtml = \`<strong>Context:</strong> \${escapeHtml(contextName)} <span title="\${escapeHtml(contextContent)}">(\${escapeHtml(shortContent)})</span>\`;
							if (clearContextBtn) clearContextBtn.style.display = 'inline';
						} else {
							if (clearContextBtn) clearContextBtn.style.display = 'none';
						}
						if (contextTextElement) contextTextElement.innerHTML = contextInfoHtml;
					}

					function attachButtonListeners(scopeElement) {
						const applyBtn = scopeElement.querySelector('.apply-changes-btn');
						const discardBtn = scopeElement.querySelector('.discard-changes-btn');

						if (applyBtn) {
							applyBtn.addEventListener('click', () => {
								if (currentSuggestion && currentSuggestion.modifiedContent) {
									applyBtn.textContent = 'Applying...';
									applyBtn.disabled = true;
									if(discardBtn) discardBtn.disabled = true;

									vscode.postMessage({
										command: 'applyChanges',
										modifiedContent: currentSuggestion.modifiedContent,
										contextType: currentSuggestion.contextType,
										selectionDetails: currentSuggestion.selectionDetails
									});
								} else {
									const errorDiv = document.createElement('div');
									errorDiv.className = 'chat-message system-message';
									errorDiv.innerHTML = '<p style="color: red;">Error: No suggestion available to apply.</p>';
									responseArea.appendChild(errorDiv);
									responseArea.scrollTop = responseArea.scrollHeight;
								}
							});
						}

						if (discardBtn) {
							discardBtn.addEventListener('click', () => {
								discardBtn.textContent = 'Discarding...';
								discardBtn.disabled = true;
								if(applyBtn) applyBtn.disabled = true;

								vscode.postMessage({ command: 'discardChanges' });

								const discardDiv = document.createElement('div');
								discardDiv.className = 'chat-message system-message';
								discardDiv.innerHTML = '<p>Suggestion discarded.</p>';
								responseArea.appendChild(discardDiv);

								if (scopeElement.classList.contains('ai-suggestion')) {
									// scopeElement.querySelectorAll('.chat-button').forEach(btn => btn.disabled = true); // Already done
								}
								currentSuggestion = { modifiedContent: '', contextType: '', selectionDetails: null };
								responseArea.scrollTop = responseArea.scrollHeight;

								// Restore main prompt input and send button
								promptInput.disabled = false;
								sendBtn.textContent = 'Send to AI';
								sendBtn.disabled = promptInput.value.trim() === '';
							});
						}
					}

					document.getElementById('getActiveFileBtn').addEventListener('click', () => {
						vscode.postMessage({ command: 'getActiveFileContext' });
					});

					document.getElementById('getSelectionBtn').addEventListener('click', () => {
						vscode.postMessage({ command: 'getSelectionContext' });
					});

					clearChatBtn.addEventListener('click', () => {
						responseArea.innerHTML = '<div class="chat-message system-message"><p>Chat cleared. Load context and enter a new prompt.</p></div>';
						currentContext = { type: '', content: '' };
						currentSuggestion = { modifiedContent: '', contextType: '', selectionDetails: null };
						updateActiveContextDisplay(null, null);
						promptInput.value = '';
						sendBtn.disabled = true;
						vscode.postMessage({ command: 'resetChatState' });
					});

					if (clearContextBtn) { // Ensure button exists before adding listener
						clearContextBtn.addEventListener('click', () => {
							currentContext = { type: '', content: '' };
							currentSuggestion = { modifiedContent: '', contextType: '', selectionDetails: null };
							updateActiveContextDisplay(null, null);

							const clearedDiv = document.createElement('div');
							clearedDiv.className = 'chat-message system-message';
							clearedDiv.innerHTML = '<p>Active code context cleared.</p>';
							responseArea.appendChild(clearedDiv);
							responseArea.scrollTop = responseArea.scrollHeight;

							vscode.postMessage({ command: 'resetChatState' });
						});
					}

					document.getElementById('sendPromptBtn').addEventListener('click', () => {
						const promptText = promptInput.value;
						if (!promptText.trim()) {
							// This case is handled by the input listener disabling the button,
							// but as a fallback:
							const errorDiv = document.createElement('div');
							errorDiv.className = 'chat-message system-message';
							errorDiv.innerHTML = '<p style="color: orange;">Please enter a prompt.</p>';
							responseArea.appendChild(errorDiv);
							responseArea.scrollTop = responseArea.scrollHeight;
							return;
						}
						// No check for currentContext.content needed here anymore due to prompt construction logic

						sendBtn.textContent = 'Processing...';
						sendBtn.disabled = true;
						promptInput.disabled = true;

						const userPromptDiv = document.createElement('div');
						userPromptDiv.className = 'chat-message user-prompt';
						userPromptDiv.innerHTML = \`<p><strong>You:</strong></p><pre>\${escapeHtml(promptText)}</pre>\`;
						responseArea.appendChild(userPromptDiv);

						promptInput.value = ''; // Clear input
						// After clearing, sendBtn should be disabled by its input listener, but let's be explicit for safety
						sendBtn.disabled = true;


						const thinkingDiv = document.createElement('div');
						thinkingDiv.className = 'chat-message ai-status';
						thinkingDiv.innerHTML = \`<p><strong>AI:</strong> Thinking...</p>\`;
						responseArea.appendChild(thinkingDiv);
						responseArea.scrollTop = responseArea.scrollHeight;

						vscode.postMessage({
							command: 'sendPromptToLLM',
							prompt: promptText, // Send the original promptText, not the cleared one
							contextType: currentContext.type,
							contextContent: currentContext.content
						});
					});

					window.addEventListener('message', event => {
						const message = event.data;
						removeLastAiStatusMessage();

						// Restore Send button and prompt input state after any response from extension
						sendBtn.textContent = 'Send to AI';
						promptInput.disabled = false;
						// Re-evaluate sendBtn disabled state based on current (cleared) promptInput
						sendBtn.disabled = promptInput.value.trim() === '';


						switch (message.command) {
							case 'availableModelsReceived':
								console.log("Received availableModelsReceived:", message.models);
								modelSelector.innerHTML = ''; // Clear existing options (e.g., "Loading models...")
								if (message.models && message.models.length > 0) {
									// Add a default "Select a Model" option if desired, or just list models
									// const defaultOption = document.createElement('option');
									// defaultOption.value = "";
									// defaultOption.textContent = "Select a language model";
									// modelSelector.appendChild(defaultOption);

									message.models.forEach(model => {
										const option = document.createElement('option');
										option.value = model.id;
										// Try to create a user-friendly name
										let displayName = model.name || model.id;
										if (model.vendor) {
											displayName = `[${model.vendor}] ${displayName}`;
										} else if (model.id.includes('copilot')) { // Specific example
											displayName = `[GitHub] Copilot (${model.id.split('/').pop()})`;
										}
										option.textContent = displayName;
										modelSelector.appendChild(option);
									});
									modelSelector.disabled = false; // Enable selector

									// Try to pre-select the active model if provided
									if (message.activeModelId) {
										modelSelector.value = message.activeModelId;
										console.log(`Pre-selected active model: ${message.activeModelId}`);
									} else {
										console.log("No active model ID provided for pre-selection.");
									}

								} else {
									const option = document.createElement('option');
									option.value = "";
									option.textContent = "No models available";
									modelSelector.appendChild(option);
									modelSelector.disabled = true; // Keep it disabled
								}
								break;
							case 'contextReceived':
								currentContext.type = message.type;
								currentContext.content = message.content;
								updateActiveContextDisplay(message.type, message.content);

								const contextDiv = document.createElement('div');
								contextDiv.className = 'chat-message system-message';
								contextDiv.innerHTML = \`<p><strong>Context Loaded: \${escapeHtml(message.type)}</strong> (<span title="\${escapeHtml(message.content)}">\${escapeHtml(message.content.substring(0, 70))}...</span>)</p>\`;
								responseArea.appendChild(contextDiv);
                                console.log("Context received:", message.type, message.content.substring(0,200));
								currentSuggestion = { modifiedContent: '', contextType: '', selectionDetails: null };
								break;
							case 'diffSuggestionReceived':
								currentSuggestion.modifiedContent = message.modifiedContent;
								currentSuggestion.contextType = message.contextType;
								currentSuggestion.selectionDetails = message.selectionDetails;

								const diffHtml = Diff2Html.html(message.diffPatch, {
									drawFileList: false,
									outputFormat: 'line-by-line',
									matching: 'lines',
									renderNothingWhenEmpty: true,
									highlightFunction: (content, language) => {
										// Check if hljs is loaded
										if (typeof hljs === 'undefined') {
											console.warn('highlight.js (hljs) not loaded.');
											return escapeHtml(content);
										}
										if (language && hljs.getLanguage(language)) {
											try {
												return hljs.highlight(content, { language: language, ignoreIllegals: true }).value;
											} catch (e) {
												console.error('hljs error:', e);
												return escapeHtml(content); // Fallback on error
											}
										}
										// Fallback for no language or if language not supported by hljs
										// Using escapeHtml directly as highlightAuto can be slow and less accurate for non-code
										// or if many languages need to be loaded for auto-detection.
										// For simple cases, or if specific languages are expected, explicit check is better.
										// If a general fallback with auto-detection is desired AND hljs.highlightAuto is configured with necessary languages:
										// try { return hljs.highlightAuto(content).value; } catch (e) { return escapeHtml(content); }
										return escapeHtml(content);
									}
								});

								const aiSuggestionDiv = document.createElement('div');
								aiSuggestionDiv.className = 'chat-message ai-suggestion';
								aiSuggestionDiv.innerHTML = \`
									<p><strong>AI Suggestion:</strong></p>
									<div class="diff-container d2h-wrapper">\${diffHtml}</div>
									<div class="button-group" style="margin-top: 10px;">
										<button class="chat-button apply-changes-btn">Apply Changes</button>
										<button class="chat-button discard-changes-btn">Discard Changes</button>
									</div>
								\`;
								responseArea.appendChild(aiSuggestionDiv);
								attachButtonListeners(aiSuggestionDiv);
								break;
							case 'llmResponseReceived':
								currentSuggestion = { modifiedContent: '', contextType: '', selectionDetails: null };
								// If an error occurs, or a non-code textual response, the active context display remains unchanged
								// unless the error implies context is no longer valid. For now, it persists.
								const aiResponseDiv = document.createElement('div');
								aiResponseDiv.className = 'chat-message ai-response';
								aiResponseDiv.innerHTML = \`<p><strong>AI:</strong></p><pre>\${escapeHtml(message.llmResponse)}</pre>\`;
								responseArea.appendChild(aiResponseDiv);
								break;
							case 'changesAppliedSuccessfully':
								const successDiv = document.createElement('div');
								successDiv.className = 'chat-message system-message';
								successDiv.innerHTML = '<p style="color: green;">Changes applied successfully!</p>';
								responseArea.appendChild(successDiv);
								currentSuggestion = { modifiedContent: '', contextType: '', selectionDetails: null };
								// Active context display remains, as changes were applied to it.
								break;
						}
						responseArea.scrollTop = responseArea.scrollHeight; // Scroll to bottom after adding any message
					});

					// Initial setup
					updateActiveContextDisplay(null, null); // Set to "No active context." initially
					responseArea.innerHTML = '<div class="chat-message system-message"><p>Welcome to Flexpilot Agent! Load context or type your query.</p></div>';

					console.log("Flexpilot Agent webview script loaded and ready.");
				</script>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
