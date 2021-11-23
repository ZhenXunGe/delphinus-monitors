import { toHexStr, toDecStr, toSS58 } from "web3subscriber/src/addresses";
import {
  EventTracker,
  withEventTracker,
} from "web3subscriber/src/sync-pending-events";
import {
  Deposit as DepositEventType,
  SwapAck as SwapAckEventType,
  WithDraw as WithDrawEventType,
} from "solidity/clients/contracts/bridge";
import {
  getConfigByChainId,
  getConfigByChainName,
} from "delphinus-deployment/src/config";
import { getTokenIndex } from "delphinus-deployment/src/token-index";

import { SubstrateClient, withL2Client as L2Client } from "../substrate/client";
import { Rio } from "./rio";
import { L1ClientRole } from "delphinus-deployment/src/types";

const BridgeJSON = require("solidity/build/contracts/Bridge.json");
const tokenIndex = getTokenIndex();

async function getConfig() {
  return await getConfigByChainName(L1ClientRole.Monitor, process.argv[2]);
}

async function withL2Client(cb: (l2Client: SubstrateClient) => Promise<void>) {
  let config = await getConfig();
  return L2Client(parseInt(config.deviceId), cb);
}

async function handleCharge(v: DepositEventType) {
  return withL2Client(async (l2Client: SubstrateClient) => {
    let l2account = toSS58(v.l2account);
    console.log("Charge token_addr:", toHexStr(v.l1token));
    await l2Client.charge(l2account, v.amount);
  });
}

async function handleDeposit(v: DepositEventType, hash: string) {
  const tokenAddr = toDecStr(v.l1token);
  const l2account = toSS58(v.l2account);

  if (tokenIndex[tokenAddr] === undefined) {
    console.log("Untracked Token ", tokenAddr);
    console.log("L1 may not be initialized, monitor exiting...");
    process.exit(0);
  }

  return withL2Client(async (l2Client: SubstrateClient) => {
    console.log("Deposit token_addr:", tokenAddr);
    console.log("To l2 account:", l2account, " with amount: ", v.amount);
    console.log("nonce:", v.nonce);
    await l2Client.deposit(
      l2account,
      tokenIndex[tokenAddr].toString(),
      v.amount,
      hash
    );
  });
}

async function handleWithDraw(v: WithDrawEventType) {
  console.log("WithDraw", v.l1account, v.l2account, v.amount, v.nonce);
}

async function handleAck(v: SwapAckEventType) {
  return withL2Client(async (l2Client: SubstrateClient) => {
    console.log("Transfer", v.l2account, v.rid);
    await l2Client.ack(v.rid);
  });
}

async function main() {
  let config = await getConfig();

  const handlers = {
    Deposit: async (v: DepositEventType, hash: string) => {
      if (toHexStr(v.l1token) == Rio.getChargeAddress(config.deviceId)) {
        await handleCharge(v);
      } else {
        await handleDeposit(v, hash);
      }
    },
    WithDraw: async (v: WithDrawEventType, _hash: string) => {
      await handleWithDraw(v);
    },
    SwapAck: async (v: SwapAckEventType, _hash: string) => {
      await handleAck(v);
    },
  };

  await withEventTracker(
    config.deviceId,
    BridgeJSON,
    config.wsSource,
    config.monitorAccount,
    config.mongodbUrl,
    (eventTracker: EventTracker) => {
      return eventTracker.syncEvents(
        async (eventName: string, v: any, hash: string) => {
          return (handlers as any)[eventName](v, hash);
        }
      );
    }
  );
  console.log("exiting...");
}

main();
