import { CdpAgentkit } from "@coinbase/cdp-agentkit-core";
import { CdpToolkit } from "@coinbase/cdp-langchain";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { CommerceSDK } from "commerce-node";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as readline from "readline";
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import { z } from "zod";
import { CdpTool } from "@coinbase/cdp-langchain";

interface ChargeRequest {
  name: string;
  description: string;
  pricing_type: string;
  local_price: {
    amount: string;
    currency: string;
  };
}

dotenv.config();

// Configure a file to persist the agent's CDP MPC Wallet Data
const WALLET_DATA_FILE = "wallet_data_mainnet.txt";

const commerce = new CommerceSDK({
  apiKey: process.env.COINBASE_COMMERCE_KEY as string,
  baseUrl: "https://api.commerce.coinbase.com",
  baseRpcUrl: "https://chain-proxy.wallet.coinbase.com",
});

// Add the create charge function before initializeAgent()
const CREATE_CHARGE_PROMPT = `
This tool creates a new charge using the Coinbase Commerce API.
Use this when you need to create a new payment request or invoice.
The charge will generate a hosted checkout page that can be shared with customers.
`;

const CreateChargeInput = z.object({
  name: z.string().describe("Name/title of the charge e.g. 'Coffee Purchase'"),
  description: z
    .string()
    .describe("Description of what is being charged for e.g. 'Large coffee with extra shot'"),
  amount: z.string().describe("Price amount as string e.g. '5.99'"),
  currency: z.string().describe("Three letter currency code e.g. 'USD'"),
  pricing_type: z
    .enum(["fixed_price", "no_price"])
    .describe("Pricing type - usually 'fixed_price'"),
});

/**
 * Creates a new charge using Coinbase Commerce API
 *
 * @param wallet - CDP wallet instance (not used but required by toolkit structure)
 * @param args - Object containing charge details
 * @returns Details about the created charge
 */
async function createCharge(
  wallet: Wallet,
  args: {
    name: string;
    description: string;
    amount: string;
    currency: string;
    pricing_type: "fixed_price" | "no_price";
  },
): Promise<string> {
  try {
    const { data: response } = await commerce.charges.createCharge({
      local_price: {
        amount: args.amount,
        currency: args.currency,
      },
      pricing_type: args.pricing_type,
    });

    return `Successfully created charge:
      Name: ${response.data.name}
      Description: ${response.data.description}
      Amount: ${response.data.pricing.local.amount} ${response.data.pricing.local.currency}
      Hosted URL: ${response.data.hostedUrl}`;
  } catch (error) {
    console.error("Error creating charge:", error);
    throw error;
  }
}

// Define the prompt for the hydrate charge action
const HYDRATE_CHARGE_PROMPT = `
This tool will hydrate a charge using the provided charge ID and chain ID.
`;

// Define the input schema using Zod
const HydrateChargeInput = z.object({
  charge_id: z.string().describe("The ID of the charge to hydrate. e.g. 'charge_12345'"),
  chain_id: z.number().describe("The ID of the blockchain to use. e.g. 1 for Ethereum Mainnet"),
});

/**
 * Hydrates a charge using the provided charge ID and chain ID
 *
 * @param wallet - The wallet to use for hydrating the charge
 * @param args - The arguments containing charge_id and chain_id
 * @returns A message indicating the success of the operation
 */
async function hydrateCharge(
  wallet: Wallet,
  args: {
    charge_id: string;
    chain_id: number;
  },
): Promise<string> {
  const walletAddress = await wallet.getDefaultAddress();
  try {
    const { data: response } = await commerce.charges.hydrateCharge(args.charge_id, {
      chain_id: args.chain_id,
      sender: walletAddress.getId(),
    });

    return `Successfully hydrated charge:
      Web3 Data: ${JSON.stringify(response.data.web3Data, null, 2)}`;
  } catch (error) {
    console.error("Error creating charge:", error);
    throw error;
  }
}

// Define the prompt for the pay charge action
const PAY_CHARGE_PROMPT = `
This tool will pay a charge using the provided charge ID and chain ID.
`;

// Define the input schema using Zod
const PayChargeInput = z.object({
  charge_id: z.string().describe("The ID of the charge to pay. e.g. 'charge_12345'"),
  chain_id: z.number().describe("The ID of the blockchain to use. e.g. 1 for Ethereum Mainnet"),
});

/**
 * Pays a charge using the provided charge ID and chain ID
 *
 * @param wallet - The wallet to use for paying the charge
 * @param args - The arguments containing charge_id and chain_id
 * @returns A message indicating the success of the operation
 */
async function payCharge(
  wallet: Wallet,
  args: {
    charge_id: string;
    chain_id: number;
  },
): Promise<string> {
  try {
    const USDC_CURRENCY = {
      contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
      isNativeAsset: false,
      decimals: 6,
    };
    const walletAddress = await wallet.getDefaultAddress();
    const { data: hydratedCharge } = await commerce.charges.hydrateCharge(args.charge_id, {
      chain_id: args.chain_id,
      sender: walletAddress.getId(),
    });

    const privateKey = walletAddress.export();
    const payerWallet = commerce.wallets.createWallet({
      secretWords: privateKey,
      chainId: 8453,
    });
    console.log(payerWallet.account?.address);
    const transactionHash = await commerce.charges.payCharge({
      walletClient: payerWallet,
      charge: hydratedCharge.data,
      currency: USDC_CURRENCY,
    });

    return `Successfully paid charge:
      Transaction Hash: ${transactionHash}`;
  } catch (error) {
    console.error("Error creating charge:", error);
    throw error;
  }
}

/**
 * Initialize the agent with CDP Agentkit
 *
 * @returns Agent executor and config
 */
async function initializeAgent() {
  try {
    // Initialize LLM with xAI configuration
    const llm = new ChatOpenAI({
      model: "gpt-4o",
      apiKey: process.env.XAI_API_KEY,
    });

    let walletDataStr: string | null = null;

    // Read existing wallet data if available
    if (fs.existsSync(WALLET_DATA_FILE)) {
      try {
        walletDataStr = fs.readFileSync(WALLET_DATA_FILE, "utf8");
      } catch (error) {
        console.error("Error reading wallet data:", error);
        // Continue without wallet data
      }
    }

    // Configure CDP Agentkit
    const config = {
      cdpWalletData: walletDataStr || undefined,
      networkId: process.env.NETWORK_ID || "base-sepolia",
    };

    // Initialize CDP agentkit
    const agentkit = await CdpAgentkit.configureWithWallet(config);

    // Initialize CDP Agentkit Toolkit and get tools
    const cdpToolkit = new CdpToolkit(agentkit);
    const tools = cdpToolkit.getTools();

    // Add this after tools are initialized
    const createChargeTool = new CdpTool(
      {
        name: "create_charge",
        description: CREATE_CHARGE_PROMPT,
        argsSchema: CreateChargeInput,
        func: createCharge,
      },
      agentkit,
    );

    tools.push(createChargeTool);

    // Create the CdpTool instance
    const hydrateChargeTool = new CdpTool(
      {
        name: "hydrate_charge",
        description: HYDRATE_CHARGE_PROMPT,
        argsSchema: HydrateChargeInput,
        func: hydrateCharge,
      },
      agentkit, // this should be whatever the instantiation of CdpWrapper is
    );

    // Add the tool to your toolkit
    tools.push(hydrateChargeTool);

    // Create the CdpTool instance
    const payChargeTool = new CdpTool(
      {
        name: "pay_charge",
        description: PAY_CHARGE_PROMPT,
        argsSchema: PayChargeInput,
        func: payCharge,
      },
      agentkit, // this should be whatever the instantiation of CdpWrapper is
    );

    // Add the tool to your toolkit
    tools.push(payChargeTool);

    // Store buffered conversation history in memory
    const memory = new MemorySaver();
    const agentConfig = {
      configurable: { thread_id: "CDP Agentkit Chatbot Example!" },
    };

    // Create React Agent using the LLM and CDP Agentkit tools
    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: memory,
      messageModifier:
        "You are a helpful agent that can interact onchain using the Coinbase Developer Platform Agentkit. You are empowered to interact onchain using your tools. If you ever need funds, you can request them from the faucet if you are on network ID `base-sepolia`. If not, you can provide your wallet details and request funds from the user. If someone asks you to do something you can't do with your currently available tools, you must say so, and encourage them to implement it themselves using the CDP SDK + Agentkit, recommend they go to docs.cdp.coinbase.com for more informaton. Be concise and helpful with your responses. If you have no funds and are on a mainnet network, the user can onramp funds using the onramp tool and you should give this link to them instead of prompting them for it. Refrain from restating your tools' descriptions unless it is explicitly requested.",
    });

    // Save wallet data
    const exportedWallet = await agentkit.exportWallet();
    fs.writeFileSync(WALLET_DATA_FILE, exportedWallet);

    return { agent, config: agentConfig };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error; // Re-throw to be handled by caller
  }
}

/**
 * Run the agent autonomously with specified intervals
 *
 * @param agent - The agent executor
 * @param config - Agent configuration
 * @param interval - Time interval between actions in seconds
 */
async function runAutonomousMode(agent: any, config: any, interval = 10) {
  console.log("Starting autonomous mode...");

  while (true) {
    try {
      const thought =
        "Be creative and do something interesting on the blockchain. " +
        "Choose an action or set of actions and execute it that highlights your abilities.";

      const stream = await agent.stream({ messages: [new HumanMessage(thought)] }, config);

      for await (const chunk of stream) {
        if ("agent" in chunk) {
          console.log(chunk.agent.messages[0].content);
        } else if ("tools" in chunk) {
          console.log(chunk.tools.messages[0].content);
        }
        console.log("-------------------");
      }

      await new Promise(resolve => setTimeout(resolve, interval * 1000));
    } catch (error) {
      if (error instanceof Error) {
        console.error("Error:", error.message);
      }
      process.exit(1);
    }
  }
}

/**
 * Run the agent interactively based on user input
 *
 * @param agent - The agent executor
 * @param config - Agent configuration
 */
async function runChatMode(agent: any, config: any) {
  console.log("Starting chat mode... Type 'exit' to end.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  try {
    while (true) {
      const userInput = await question("\nPrompt: ");

      if (userInput.toLowerCase() === "exit") {
        break;
      }

      const stream = await agent.stream({ messages: [new HumanMessage(userInput)] }, config);

      for await (const chunk of stream) {
        if ("agent" in chunk) {
          console.log(chunk.agent.messages[0].content);
        } else if ("tools" in chunk) {
          console.log(chunk.tools.messages[0].content);
        }
        console.log("-------------------");
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error:", error.message);
    }
    process.exit(1);
  } finally {
    rl.close();
  }
}

/**
 * Choose whether to run in autonomous or chat mode based on user input
 *
 * @returns Selected mode
 */
async function chooseMode(): Promise<"chat" | "auto"> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  while (true) {
    console.log("\nAvailable modes:");
    console.log("1. chat    - Interactive chat mode");
    console.log("2. auto    - Autonomous action mode");

    const choice = (await question("\nChoose a mode (enter number or name): "))
      .toLowerCase()
      .trim();

    if (choice === "1" || choice === "chat") {
      rl.close();
      return "chat";
    } else if (choice === "2" || choice === "auto") {
      rl.close();
      return "auto";
    }
    console.log("Invalid choice. Please try again.");
  }
}

/**
 * Start the chatbot agent
 */
async function main() {
  try {
    const { agent, config } = await initializeAgent();
    const mode = await chooseMode();

    if (mode === "chat") {
      await runChatMode(agent, config);
    } else {
      await runAutonomousMode(agent, config);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error:", error.message);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  console.log("Starting Agent...");
  main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
