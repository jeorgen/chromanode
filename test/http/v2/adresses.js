import _ from 'lodash'
import { expect } from 'chai'
import bitcore from 'bitcore'
import PUtils from 'promise-useful-utils'

const ZERO_HASH = new Array(65).join('0')

export default function (opts) {
  let request = require('../request')(opts)

  describe('addresses', () => {
    let addresses = []
    let transactions = []
    let unspent = []
    let latest = {}

    let heightCache = {}
    async function getHeightByTxId (txid) {
      if (heightCache[txid] === undefined) {
        let hash = (await opts.bitcoind.rpc.getRawTransaction(txid, 1)).result.blockhash
        heightCache[txid] = hash === undefined
          ? null
          : (await opts.bitcoind.rpc.getBlock(hash)).result.height
      }

      return heightCache[txid]
    }

    let txCache = {}
    async function getTx (txid) {
      if (txCache[txid] === undefined) {
        let rawtx = (await opts.bitcoind.rpc.getRawTransaction(txid)).result
        txCache[txid] = bitcore.Transaction(rawtx)
      }

      return txCache[txid]
    }

    function createAddress (script) {
      let hash = script.isPublicKeyHashOut()
        ? script.chunks[2].buf
        : bitcore.crypto.Hash.sha256ripemd160(script.chunks[0].buf)
      return new bitcore.Address(hash, 'regtest', bitcore.Address.PayToPublicKeyHash).toString()
    }

    before(async () => {
      let txids = _.filter(await opts.bitcoind.generateTxs(10))
      do {
        await PUtils.delay(500)
        for (let txid of txids) {
          try {
            await request.get('/v2/transactions/raw', {txid: txid})
            txids = _.without(txids, txid)
          } catch (err) {
            if (!(err instanceof request.errors.StatusFail)) {
              throw err
            }
            console.log(`${txid} not ready yet`)
          }
        }
      } while (txids.length > 0)

      // select addresses
      let result = (await opts.bitcoind.rpc.getAddressesByAccount('')).result
      addresses = _.sample(result, 5)

      // get transactions
      result = (await opts.bitcoind.rpc.listTransactions('*', 1e6)).result
      txids = _.unique(_.pluck(result, 'txid'))
      await PUtils.map(txids, async (txid) => {
        let tx = await getTx(txid)
        let oAddrs = tx.outputs.map((output) => createAddress(output.script))
        let required = _.intersection(addresses, oAddrs).length > 0

        if (!required) {
          for (let input of tx.inputs) {
            let txid = input.prevTxId.toString('hex')
            if (!(txid === ZERO_HASH && input.outputIndex === 0xFFFFFFFF)) {
              let tx = await getTx(txid)
              let addr = createAddress(tx.outputs[input.outputIndex].script)
              if (addresses.includes(addr)) {
                required = true
                break
              }
            }
          }
        }

        if (required) {
          transactions.push({
            txid: txid,
            height: await getHeightByTxId(txid)
          })
        }
      }, {concurrency: 10})
      transactions = _.sortByAll(transactions, 'height', 'txid')

      // get unspent
      await PUtils.map(transactions, async (row) => {
        let tx = await getTx(row.txid)
        for (let index = 0; index < tx.outputs.length; ++index) {
          let output = tx.outputs[index]
          let address = createAddress(output.script)
          if (addresses.includes(address)) {
            let txOut = await opts.bitcoind.rpc.getTxOut(row.txid, index, true)
            if (txOut.result !== null) {
              unspent.push({
                txid: row.txid,
                vout: index,
                value: output.satoshis,
                script: output.script.toHex(),
                height: row.height
              })
            }
          }
        }
      }, {concurrency: 10})
      unspent = _.sortByAll(unspent, 'height', 'txid', 'vout')

      // get latest
      latest = {
        height: (await opts.bitcoind.rpc.getBlockCount()).result,
        hash: (await opts.bitcoind.rpc.getBestBlockHash()).result
      }
    })

    it('only addresses', async () => {
      let result = await request.get(
        '/v2/addresses/query', {addresses: addresses})
      expect(result).to.be.an('Object')

      let sortedResult = {
        transactions: _.sortByAll(result.transactions, 'height', 'txid'),
        latest: result.latest
      }
      expect(sortedResult).to.deep.equal({transactions: transactions, latest: latest})

      delete result.transactions
      delete result.latest
      expect(result).to.deep.equal({})
    })

    it('get unspent', async () => {
      let result = await request.get(
        '/v2/addresses/query', {addresses: addresses, status: 'unspent'})
      expect(result).to.be.an('Object')

      let sortedResult = {
        unspent: _.sortByAll(result.unspent, 'height', 'txid', 'vout'),
        latest: result.latest
      }
      expect(sortedResult).to.deep.equal({unspent: unspent, latest: latest})

      delete result.unspent
      delete result.latest
      expect(result).to.deep.equal({})
    })

    it('source mempool', async () => {
      let result = await request.get(
        '/v2/addresses/query', {addresses: addresses, source: 'mempool'})
      expect(result).to.be.an('Object')
      expect(result.latest).to.deep.equal(latest)

      let sorted = _.sortByAll(result.transactions, 'height', 'txid')
      expect(sorted).to.deep.equal(_.filter(transactions, {height: null}))

      delete result.transactions
      delete result.latest
      expect(result).to.deep.equal({})
    })

    it('from not default', async () => {
      let from = _.chain(transactions).pluck('height').filter().first().value()

      let result = await request.get(
        '/v2/addresses/query', {addresses: addresses, from: from})
      expect(result).to.be.an('Object')
      expect(result.latest).to.deep.equal(latest)

      let sorted = _.sortByAll(result.transactions, 'height', 'txid')
      expect(sorted).to.deep.equal(transactions.filter((row) => {
        return row.height === null || row.height > from
      }))

      delete result.transactions
      delete result.latest
      expect(result).to.deep.equal({})
    })

    it('to not default', async () => {
      let to = _.chain(transactions).pluck('height').filter().last().value() - 1

      let result = await request.get(
        '/v2/addresses/query', {addresses: addresses, to: to})
      expect(result).to.be.an('Object')
      expect(result.latest).to.deep.equal(latest)

      let sorted = _.sortByAll(result.transactions, 'height', 'txid')
      expect(sorted).to.deep.equal(transactions.filter((row) => {
        return row.height === null || row.height <= to
      }))

      delete result.transactions
      delete result.latest
      expect(result).to.deep.equal({})
    })
  })
}
