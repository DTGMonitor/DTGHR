import { useState } from "react";
import { Link } from "react-router-dom";
import { Laptop } from "lucide-react";

import { assetService, type Asset } from "@/services/assetService";
import { ticketService, type Ticket } from "@/services/ticketService";

/*
 * Which asset a ticket concerns. Everybody on the ticket sees the tag; IT
 * links it, changes it or removes it, and the asset's history then shows the
 * ticket -- so a laptop's repairs are on the laptop.
 *
 * The picker offers the reporter's own items first, since a ticket is most
 * often about the reporter's own laptop.
 */
export default function AssetLink({
    ticket,
    onChange,
    onError,
}: {
    ticket: Ticket;
    onChange: (t: Ticket) => void;
    onError: (e: unknown) => void;
}) {
    const [choosing, setChoosing] = useState(false);
    const [options, setOptions] = useState<Asset[] | null>(null);
    const [chosen, setChosen] = useState("");

    const choose = async () => {
        setChoosing(true);
        if (options) return;
        try {
            const res = await assetService.list(false);
            const theirs = (a: Asset) => a.holder?.employee_id === ticket.reporter_id;
            setOptions(
                [...res.data.items].sort((a, b) => Number(theirs(b)) - Number(theirs(a)) || a.tag.localeCompare(b.tag)),
            );
        } catch (e) {
            onError(e);
            setChoosing(false);
        }
    };

    const save = async (assetId: string | null) => {
        try {
            onChange((await ticketService.linkAsset(ticket.id, assetId)).data);
            setChoosing(false);
            setChosen("");
        } catch (e) {
            onError(e);
        }
    };

    if (!ticket.asset && !ticket.can_work) return null;

    return (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-paper-soft">
            <Laptop className="h-3.5 w-3.5 text-muted" />
            {ticket.asset ? (
                <>
                    Concerns{" "}
                    {ticket.can_work ? (
                        <Link to={`/equipment?open=${ticket.asset.id}`} className="font-mono text-signal hover:underline">
                            {ticket.asset.tag}
                        </Link>
                    ) : (
                        <span className="font-mono">{ticket.asset.tag}</span>
                    )}
                    <span>{ticket.asset.name}</span>
                </>
            ) : (
                !choosing && (
                    <button type="button" onClick={() => void choose()} className="transition hover:text-paper">
                        Link to an asset
                    </button>
                )
            )}
            {ticket.can_work && ticket.asset && !choosing && (
                <>
                    <button type="button" onClick={() => void choose()} className="transition hover:text-paper">
                        Change
                    </button>
                    <button type="button" onClick={() => void save(null)} className="transition hover:text-paper">
                        Unlink
                    </button>
                </>
            )}
            {choosing && (
                <>
                    <select
                        value={chosen}
                        onChange={(e) => setChosen(e.target.value)}
                        aria-label="Asset"
                        className="max-w-xs rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-paper"
                    >
                        <option value="" className="bg-surface">
                            {options ? "Choose an asset…" : "Loading…"}
                        </option>
                        {options?.map((a) => (
                            <option key={a.id} value={a.id} className="bg-surface">
                                {a.tag} · {a.name}
                                {a.holder?.name ? ` (${a.holder.name})` : ""}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        disabled={!chosen}
                        onClick={() => void save(chosen)}
                        className="dtg-btn-secondary px-2.5 py-1 text-xs"
                    >
                        Link
                    </button>
                    <button type="button" onClick={() => setChoosing(false)} className="transition hover:text-paper">
                        Cancel
                    </button>
                </>
            )}
        </div>
    );
}
