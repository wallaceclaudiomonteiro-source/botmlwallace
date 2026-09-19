import { useEffect, useState } from "react";
import React from "react";

// Função auxiliar para formatar a data como "DD.MM"
const getTodayDateFormatted = () => {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
};

export default function MarketsAll() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const todayDate = getTodayDateFormatted();

    fetch(`/api/markets/all?date=${todayDate}`)
      .then(res => res.json())
      .then(json => {
        setData(json.results || []);
        setLoading(false);
      })
      .catch((error) => {
        console.error("Erro ao buscar dados da API:", error);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="p-6 text-xl">Carregando...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Mercados (Limpo)</h1>

      {data.length === 0 && (
        <div className="p-4 bg-yellow-900 text-yellow-300 rounded-lg">
          Nenhum jogo encontrado para a data de hoje ({getTodayDateFormatted()}).
        </div>
      )}

      {data.map((jogo, index) => (
        <div key={index} className="border border-gray-700 p-4 rounded-xl mb-6 bg-gray-900 text-white">
          
          {/* TÍTULO DO JOGO */}
          <h2 className="text-xl font-semibold mb-2">
            {jogo.goals?.home} vs {jogo.goals?.away}
          </h2>

          {/* ===== MERCADO DE GOLS ===== */}
          {jogo.goals && (
            <div className="mb-4">
              <h3 className="font-bold">Gols</h3>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <p>Home +0.5: <b>{jogo.goals?.team_goals?.home_over_0_5}%</b></p>
                <p>Home +1.5: <b>{jogo.goals?.team_goals?.home_over_1_5}%</b></p>
                <p>Away +0.5: <b>{jogo.goals?.team_goals?.away_over_0_5}%</b></p>
                <p>Away +1.5: <b>{jogo.goals?.team_goals?.away_over_1_5}%</b></p>
              </div>

              {/* ✅ TOTAL DE GOLS — ADIÇÃO */}
              {jogo.goals_totals && (
                <div className="mt-4">
                  <h4 className="font-semibold">Totais</h4>
                  <div className="grid grid-cols-2 gap-2 pl-2 mt-1">
                    <p>Total +0.5: <b>{jogo.goals_totals?.over_0_5}%</b></p>
                    <p>Total +1.5: <b>{jogo.goals_totals?.over_1_5}%</b></p>
                    <p>Total +2.5: <b>{jogo.goals_totals?.over_2_5}%</b></p>
                    <p>Total +3.5: <b>{jogo.goals_totals?.over_3_5}%</b></p>
                    <p>Total +4.5: <b>{jogo.goals_totals?.over_4_5}%</b></p>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* ===== MERCADO DE ESCANTEIOS ===== */}
          {jogo.corners && (
            <div className="mb-4">
              <h3 className="font-bold">Escanteios</h3>

              {/* HOME */}
              <div className="mt-2">
                <p className="font-semibold">Home</p>
                <div className="grid grid-cols-2 gap-2 pl-2">
                  <p>+0.5: <b>{jogo.corners?.home_corners_pro?.over_0_5}%</b></p>
                  <p>+5.5: <b>{jogo.corners?.home_corners_pro?.over_5_5}%</b></p>
                  <p>+8.5: <b>{jogo.corners?.home_corners_pro?.over_8_5}%</b></p>
                </div>

                {/* AWAY */}
                <p className="font-semibold mt-3">Away</p>
                <div className="grid grid-cols-2 gap-2 pl-2">
                  <p>+0.5: <b>{jogo.corners?.away_corners_pro?.over_0_5}%</b></p>
                  <p>+5.5: <b>{jogo.corners?.away_corners_pro?.over_5_5}%</b></p>
                  <p>+8.5: <b>{jogo.corners?.away_corners_pro?.over_8_5}%</b></p>
                </div>

                {/* ✅ TOTAL DE ESCANTEIOS — OK */}
                {jogo.corners?.totals && (
                  <>
                    <p className="font-semibold mt-3">Totais</p>
                    <div className="grid grid-cols-2 gap-2 pl-2">
                      <p>Total +0.5:  <b>{jogo.corners?.totals?.over_0_5}%</b></p>
                      <p>Total +5.5:  <b>{jogo.corners?.totals?.over_5_5}%</b></p>
                      <p>Total +8.5:  <b>{jogo.corners?.totals?.over_8_5}%</b></p>
                      <p>Total +9.5:  <b>{jogo.corners?.totals?.over_9_5}%</b></p>
                      <p>Total +10.5: <b>{jogo.corners?.totals?.over_10_5}%</b></p>
                      <p>Total +11.5: <b>{jogo.corners?.totals?.over_11_5}%</b></p>
                    </div>
                  </>
                )}

              </div>
            </div>
          )}

          {/* ===== MERCADO DE CARTÕES ===== */}
          {jogo.cards && (
            <div className="mb-4">
              <h3 className="font-bold">Cartões</h3>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <p>Home +2.5 cartões: <b>{jogo.cards?.home_cards?.overs?.over_2_5}%</b></p>
                <p>Away +2.5 cartões: <b>{jogo.cards?.away_cards?.overs?.over_2_5}%</b></p>
                <p>Home +4.5 cartões: <b>{jogo.cards?.home_cards?.overs?.over_4_5}%</b></p>
                <p>Away +4.5 cartões: <b>{jogo.cards?.away_cards?.overs?.over_4_5}%</b></p>
              </div>

              {/* ✅ TOTAL DE CARTÕES — ADIÇÃO */}
              {jogo.cards_totals && (
                <div className="mt-4">
                  <h4 className="font-semibold">Totais</h4>
                  <div className="grid grid-cols-2 gap-2 pl-2 mt-1">
                    <p>Total +2.5 cartões: <b>{jogo.cards_totals?.over_2_5}%</b></p>
                    <p>Total +3.5 cartões: <b>{jogo.cards_totals?.over_3_5}%</b></p>
                    <p>Total +4.5 cartões: <b>{jogo.cards_totals?.over_4_5}%</b></p>
                  </div>
                </div>
              )}

            </div>
          )}

        </div>
      ))}
    </div>
  );
}
